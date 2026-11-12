import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ensureCodedStages,
  ensureDefaultPipeline,
} from '../leads/lead-stage.util.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  conflict,
  forbidden,
  invalidBody,
  notFound,
} from '../pipelines/pipeline-errors.js';
import {
  MAX_PIPELINES,
  validateStageOrder,
} from '../pipelines/pipeline-rules.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const CreateBody = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();
const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    position: z.number().int().min(0).max(1000).optional(),
    aiStaging: z.enum(['OFF', 'SUGGEST', 'AUTO']).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.position !== undefined ||
      body.aiStaging !== undefined,
  );
const OrderBody = z
  .object({ stageIds: z.array(z.string().uuid()).max(100) })
  .strict();

export interface PipelineView {
  id: string;
  /** `null` for the unnamed default pipeline (the web shows its label). */
  name: string | null;
  position: number;
  isDefault: boolean;
  /** ADR 058: who may move leads along the funnel automatically. */
  aiStaging: 'OFF' | 'SUGGEST' | 'AUTO';
  stageCount: number;
  leadCount: number;
}

interface StageView {
  id: string;
  code: string | null;
  name: string | null;
  position: number;
  pipelineId: string;
  kind: 'OPEN' | 'WON' | 'LOST';
}

type Db = Pick<PrismaService, 'pipeline' | 'leadStage' | 'lead'>;

async function view(db: Db, tenantId: string): Promise<PipelineView[]> {
  const pipelines = await db.pipeline.findMany({
    where: { tenantId, archivedAt: null },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      position: true,
      isDefault: true,
      aiStaging: true,
    },
  });
  const [stages, leads] = await Promise.all([
    db.leadStage.groupBy({
      by: ['pipelineId'],
      where: { tenantId, archivedAt: null },
      _count: { _all: true },
    }),
    db.lead.groupBy({
      by: ['pipelineId'],
      where: { tenantId },
      _count: { _all: true },
    }),
  ]);
  const stageCount = new Map(stages.map((r) => [r.pipelineId, r._count._all]));
  const leadCount = new Map(leads.map((r) => [r.pipelineId, r._count._all]));
  return pipelines.map((p) => ({
    ...p,
    stageCount: stageCount.get(p.id) ?? 0,
    leadCount: leadCount.get(p.id) ?? 0,
  }));
}

/**
 * Pipelines (ADR 057): list for every role; create, rename, reorder,
 * archive and make-default for OWNER and ADMIN. Archive, never delete.
 */
@Controller('api/v1/pipelines')
@UseGuards(SessionGuard)
export class PipelinesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() request: InboxRequest): Promise<{ items: PipelineView[] }> {
    const tenantId = request.principal!.tenantId;
    await this.prisma.$transaction((tx) => ensureDefaultPipeline(tx, tenantId));
    return { items: await view(this.prisma, tenantId) };
  }

  @Post()
  async create(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<PipelineView> {
    const who = this.manager(request);
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    return this.prisma.$transaction(async (tx) => {
      await this.lockTenant(tx, who.tenantId);
      await ensureDefaultPipeline(tx, who.tenantId);
      const active = await tx.pipeline.findMany({
        where: { tenantId: who.tenantId, archivedAt: null },
        select: { position: true },
      });
      if (active.length >= MAX_PIPELINES)
        throw conflict('PIPELINE_LIMIT', 'Maximum number of pipelines reached');
      const created = await tx.pipeline.create({
        data: {
          tenantId: who.tenantId,
          name: parsed.data.name,
          position: Math.max(...active.map((p) => p.position)) + 1,
          // ADR 058: new pipelines start with AI staging on.
          aiStaging: 'AUTO',
        },
        select: { id: true },
      });
      await ensureCodedStages(tx, who.tenantId, created.id);
      await this.audit(tx, who, 'pipeline.created', created.id, {});
      return (await view(tx, who.tenantId)).find((p) => p.id === created.id)!;
    });
  }

  @Patch(':id')
  async update(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PipelineView> {
    const who = this.manager(request);
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.pipeline.updateMany({
        where: { tenantId: who.tenantId, id, archivedAt: null },
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.position !== undefined
            ? { position: parsed.data.position }
            : {}),
          ...(parsed.data.aiStaging !== undefined
            ? { aiStaging: parsed.data.aiStaging }
            : {}),
        },
      });
      if (found.count === 0) throw notFound();
      await this.audit(tx, who, 'pipeline.updated', id, {
        fields: Object.keys(parsed.data).sort().join(','),
      });
      return (await view(tx, who.tenantId)).find((p) => p.id === id)!;
    });
  }

  @Delete(':id')
  async archive(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string; archived: true }> {
    const who = this.manager(request);
    return this.prisma.$transaction(async (tx) => {
      await this.lockTenant(tx, who.tenantId);
      const pipeline = await tx.pipeline.findFirst({
        where: { tenantId: who.tenantId, id, archivedAt: null },
        select: { id: true, isDefault: true },
      });
      if (!pipeline) throw notFound();
      if (pipeline.isDefault)
        throw conflict(
          'PIPELINE_IS_DEFAULT',
          'The default pipeline cannot be archived',
        );
      const leadCount = await tx.lead.count({
        where: { tenantId: who.tenantId, pipelineId: id },
      });
      if (leadCount > 0)
        throw conflict(
          'PIPELINE_HAS_LEADS',
          'Move the leads out of this pipeline first',
          { leadCount },
        );
      await tx.pipeline.updateMany({
        where: { tenantId: who.tenantId, id },
        data: { archivedAt: new Date() },
      });
      await this.audit(tx, who, 'pipeline.archived', id, {});
      return { id, archived: true as const };
    });
  }

  @Post(':id/make-default')
  async makeDefault(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ items: PipelineView[] }> {
    const who = this.manager(request);
    return this.prisma.$transaction(async (tx) => {
      await this.lockTenant(tx, who.tenantId);
      const target = await tx.pipeline.findFirst({
        where: { tenantId: who.tenantId, id, archivedAt: null },
        select: { id: true, isDefault: true },
      });
      if (!target) throw notFound();
      if (!target.isDefault) {
        // The old default keeps a stored name (only the default is unnamed).
        await tx.pipeline.updateMany({
          where: {
            tenantId: who.tenantId,
            isDefault: true,
            archivedAt: null,
            name: null,
          },
          data: { name: 'Sales' },
        });
        await tx.pipeline.updateMany({
          where: {
            tenantId: who.tenantId,
            isDefault: true,
            archivedAt: null,
          },
          data: { isDefault: false },
        });
        await tx.pipeline.updateMany({
          where: { tenantId: who.tenantId, id },
          data: { isDefault: true },
        });
        await ensureCodedStages(tx, who.tenantId, id);
        await this.audit(tx, who, 'pipeline.made_default', id, {});
      }
      return { items: await view(tx, who.tenantId) };
    });
  }

  @Put(':id/stages/order')
  async reorder(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<StageView[]> {
    const who = this.manager(request);
    const parsed = OrderBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    return this.prisma.$transaction(async (tx) => {
      await this.lockTenant(tx, who.tenantId);
      const pipeline = await tx.pipeline.findFirst({
        where: { tenantId: who.tenantId, id, archivedAt: null },
        select: { id: true },
      });
      if (!pipeline) throw notFound();
      const active = await tx.leadStage.findMany({
        where: { tenantId: who.tenantId, pipelineId: id, archivedAt: null },
        select: { id: true },
      });
      const { stageIds } = parsed.data;
      if (
        !validateStageOrder(
          stageIds,
          active.map((s) => s.id),
        )
      )
        throw invalidBody();
      for (const [position, stageId] of stageIds.entries())
        await tx.leadStage.updateMany({
          where: { tenantId: who.tenantId, pipelineId: id, id: stageId },
          data: { position },
        });
      await this.audit(tx, who, 'lead.stage.reordered', id, {
        stages: String(stageIds.length),
      });
      return tx.leadStage.findMany({
        where: { tenantId: who.tenantId, pipelineId: id, archivedAt: null },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          position: true,
          pipelineId: true,
          kind: true,
        },
      });
    });
  }

  private manager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const { tenantId, operatorId, role } = request.principal!;
    if (role !== 'OWNER' && role !== 'ADMIN') throw forbidden();
    return { tenantId, operatorId };
  }

  private async lockTenant(
    tx: Pick<PrismaService, '$queryRaw'>,
    tenantId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
  }

  private async audit(
    tx: Pick<PrismaService, 'auditEvent'>,
    who: { tenantId: string; operatorId: string },
    action: string,
    entityId: string,
    safeInputSummary: Record<string, string>,
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId: who.tenantId,
        actorType: 'OPERATOR',
        actorId: who.operatorId,
        action,
        entityType: 'pipeline',
        entityId,
        safeInputSummary,
      },
    });
  }
}
