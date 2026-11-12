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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import { ensureDefaultPipeline } from '../leads/lead-stage.util.js';
import { moveLeadToStage } from '../leads/lead-stage-move.js';
import {
  conflict,
  forbidden,
  invalidBody,
  invalidQuery,
  invalidValue,
  notFound,
  unknownOperator,
} from '../pipelines/pipeline-errors.js';
import {
  checkLostReason,
  fromDateOnly,
  isCalendarDate,
  MAX_LOST_REASON,
  MAX_STAGES_PER_PIPELINE,
  parseOpportunityPatch,
  toDateOnly,
} from '../pipelines/pipeline-rules.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  describeFields,
  type FieldValue,
} from '../tags/custom-field-values.js';
import {
  CustomFieldsService,
  type FieldValueView,
} from '../tags/custom-fields.service.js';
import { parseFieldFilter } from '../tags/field-filter.js';
import {
  activeFieldDefs,
  tagsOfLeads,
  type TagView,
} from '../tags/tag-reads.js';
import { TagsService } from '../tags/tags.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';
import {
  operating,
  parseId,
  parseTagIds,
  parseValues,
} from './tag-assignment.js';

const ListQuery = z.object({
  stageId: z.string().uuid().optional(),
  pipelineId: z.string().uuid().optional(),
  ownerOperatorId: z.string().uuid().optional(),
  source: z.string().trim().min(1).max(60).optional(),
  closeBefore: z.string().refine(isCalendarDate).optional(),
  closeAfter: z.string().refine(isCalendarDate).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  tagId: z.string().uuid().optional(),
  fieldKey: z.string().max(64).optional(),
  fieldValue: z.string().max(600).optional(),
});
const StageBody = z.object({ name: z.string().trim().min(1).max(80) });
const CreateStageBody = z.object({
  name: z.string().trim().min(1).max(80),
  pipelineId: z.string().uuid().optional(),
});
const StagesQuery = z.object({ pipelineId: z.string().uuid().optional() });
const MoveBody = z.object({
  stageId: z.string().uuid(),
  /** Required when the stage is a LOST stage (ADR 058). */
  lostReason: z.string().trim().max(MAX_LOST_REASON).nullable().optional(),
});
const STAGE_SELECT = {
  id: true,
  code: true,
  name: true,
  position: true,
  pipelineId: true,
} as const;

interface LeadStageView {
  id: string;
  code: string | null;
  name: string | null;
  position: number;
  /** ADR 057 (additive). */
  pipelineId: string;
}

export interface OpportunityView {
  id: string;
  status: string;
  pipelineId: string;
  ownerOperatorId: string | null;
  owner: { id: string; displayName: string } | null;
  /** Decimal string (`1500.50`), never a JS number. */
  amount: string | null;
  currency: string | null;
  source: string | null;
  /** `YYYY-MM-DD`. */
  expectedCloseDate: string | null;
  lostReason: string | null;
}

interface LeadPipelineItem {
  id: string;
  pipelineId: string;
  pipelineStageId: string | null;
  ownerOperatorId: string | null;
  owner: { id: string; displayName: string } | null;
  amount: string | null;
  currency: string | null;
  source: string | null;
  expectedCloseDate: string | null;
  lostReason: string | null;
  score: string;
  status: string;
  summary: string;
  createdAt: Date;
  updatedAt: Date;
  contact: { name: string | null; phone: string | null };
  /** `channelType` of the conversation's channel account (card badge). */
  conversation: { id: string; state: string; channelType: string };
  /** Active tags and custom field values (ADR 053). */
  tags: TagView[];
  customFields: Array<{
    key: string;
    label: string;
    type: string;
    value: FieldValue | null;
  }>;
}

@Controller('api/v1/leads')
@UseGuards(SessionGuard)
export class LeadPipelineController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
    private readonly fields: CustomFieldsService,
  ) {}

  /** Replaces the tag set of a lead (ADR 053). */
  @Put(':id/tags')
  async setTags(
    @Req() request: InboxRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ tags: TagView[] }> {
    const principal = operating(request);
    const tagIds = parseTagIds(body);
    return this.tags.setTags(
      principal.tenantId,
      principal.operatorId,
      'lead',
      parseId(id),
      tagIds,
    );
  }

  /** Merges custom field values into a lead (ADR 053). */
  @Patch(':id/custom-fields')
  async setCustomFields(
    @Req() request: InboxRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ customFields: FieldValueView[] }> {
    const principal = operating(request);
    const values = parseValues(body);
    return this.fields.patchValues(
      principal.tenantId,
      principal.operatorId,
      'lead',
      parseId(id),
      values,
    );
  }

  /** Opportunity fields of a lead (ADR 057): OWNER, ADMIN, OPERATOR. */
  @Patch(':id/opportunity')
  async opportunity(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) leadId: string,
    @Body() body: unknown,
  ): Promise<OpportunityView> {
    const who = request.principal!;
    if (who.role === 'VIEWER') throw forbidden();
    const parsed = parseOpportunityPatch(body);
    if (!parsed.ok)
      throw parsed.code === 'INVALID_BODY' ? invalidBody() : invalidValue();
    const patch = parsed.patch;
    return this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { tenantId: who.tenantId, id: leadId },
        select: { id: true, status: true },
      });
      if (!lead) throw notFound();
      if (patch.lostReason !== undefined) {
        const violation = checkLostReason(lead.status, patch.lostReason);
        if (lead.status !== 'LOST' || violation === 'REQUIRED')
          throw invalidValue();
      }
      if (patch.ownerOperatorId) {
        // FOR SHARE: a concurrent deactivation waits and then clears it.
        const owner = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "operators"
          WHERE "tenant_id" = ${who.tenantId}::uuid
            AND "id" = ${patch.ownerOperatorId}::uuid AND "is_active" = true
          FOR SHARE`;
        if (owner.length === 0) throw unknownOperator();
      }
      const data: Prisma.LeadUncheckedUpdateManyInput = {};
      if (patch.ownerOperatorId !== undefined)
        data.ownerOperatorId = patch.ownerOperatorId;
      if (patch.amount !== undefined) {
        data.amount =
          patch.amount === null ? null : new Prisma.Decimal(patch.amount);
        data.currency = patch.currency ?? null;
      }
      if (patch.source !== undefined) data.source = patch.source;
      if (patch.expectedCloseDate !== undefined)
        data.expectedCloseDate =
          patch.expectedCloseDate === null
            ? null
            : toDateOnly(patch.expectedCloseDate);
      if (patch.lostReason !== undefined) data.lostReason = patch.lostReason;
      await tx.lead.updateMany({
        where: { tenantId: who.tenantId, id: leadId },
        data,
      });
      await tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorType: 'OPERATOR',
          actorId: who.operatorId,
          action: 'lead.opportunity.updated',
          entityType: 'lead',
          entityId: leadId,
          // Field names only: amounts are never written to the audit log.
          safeInputSummary: { fields: Object.keys(patch).sort().join(',') },
        },
      });
      const updated = await tx.lead.findFirstOrThrow({
        where: { tenantId: who.tenantId, id: leadId },
        select: {
          id: true,
          status: true,
          pipelineId: true,
          ownerOperatorId: true,
          amount: true,
          currency: true,
          source: true,
          expectedCloseDate: true,
          lostReason: true,
          owner: { select: { id: true, displayName: true } },
        },
      });
      const { owner, amount, expectedCloseDate, ...rest } = updated;
      return {
        ...rest,
        owner,
        amount: amount ? amount.toFixed(2) : null,
        expectedCloseDate: fromDateOnly(expectedCloseDate),
      };
    });
  }

  @Get('stages')
  async stages(
    @Req() request: InboxRequest,
    @Query() query: unknown = {},
  ): Promise<LeadStageView[]> {
    const parsed = StagesQuery.safeParse(query);
    if (!parsed.success) throw invalidQuery();
    const tenantId = request.principal!.tenantId;
    const { pipelineId: defaultId } = await this.prisma.$transaction((tx) =>
      ensureDefaultPipeline(tx, tenantId),
    );
    const pipelineId = parsed.data.pipelineId ?? defaultId;
    if (pipelineId !== defaultId) {
      const found = await this.prisma.pipeline.findFirst({
        where: { tenantId, id: pipelineId, archivedAt: null },
        select: { id: true },
      });
      if (!found) throw notFound();
    }
    return this.prisma.leadStage.findMany({
      where: { tenantId, pipelineId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: STAGE_SELECT,
    });
  }

  @Post('stages')
  async createStage(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<LeadStageView> {
    const who = this.requireManager(request);
    const parsed = CreateStageBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${who.tenantId}::uuid FOR UPDATE`;
      const { pipelineId: defaultId } = await ensureDefaultPipeline(
        tx,
        who.tenantId,
      );
      const pipelineId = parsed.data.pipelineId ?? defaultId;
      const pipeline = await tx.pipeline.findFirst({
        where: { tenantId: who.tenantId, id: pipelineId, archivedAt: null },
        select: { id: true },
      });
      if (!pipeline) throw notFound();
      const count = await tx.leadStage.count({
        where: { tenantId: who.tenantId, pipelineId, archivedAt: null },
      });
      if (count >= MAX_STAGES_PER_PIPELINE)
        throw conflict(
          'LEAD_STAGE_LIMIT',
          'Maximum number of lead stages reached',
        );
      const last = await tx.leadStage.findFirst({
        where: { tenantId: who.tenantId, pipelineId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const stage = await tx.leadStage.create({
        data: {
          tenantId: who.tenantId,
          pipelineId,
          name: parsed.data.name,
          position: (last?.position ?? -1) + 1,
        },
        select: STAGE_SELECT,
      });
      await tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorType: 'OPERATOR',
          actorId: who.operatorId,
          action: 'lead.stage.created',
          entityType: 'lead_stage',
          entityId: stage.id,
          safeInputSummary: {
            position: String(stage.position),
            pipelineId,
          },
        },
      });
      return stage;
    });
  }

  @Patch('stages/:id')
  async renameStage(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) stageId: string,
    @Body() body: unknown,
  ): Promise<LeadStageView> {
    const who = this.requireManager(request);
    const parsed = StageBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    return this.prisma.$transaction(async (tx) => {
      const stage = await tx.leadStage.findFirst({
        where: { tenantId: who.tenantId, id: stageId },
        select: { id: true, code: true, position: true },
      });
      if (!stage) throw notFound();
      const updated = await tx.leadStage.update({
        where: { tenantId_id: { tenantId: who.tenantId, id: stageId } },
        data: { name: parsed.data.name },
        select: STAGE_SELECT,
      });
      await tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorType: 'OPERATOR',
          actorId: who.operatorId,
          action: 'lead.stage.renamed',
          entityType: 'lead_stage',
          entityId: stage.id,
          safeInputSummary: { code: stage.code ?? 'CUSTOM' },
        },
      });
      return updated;
    });
  }

  /**
   * Deletes an empty stage (ADR 057). The coded stages of the default
   * pipeline are required by the agent; a stage that holds leads is refused
   * (the operator moves them first).
   */
  @Delete('stages/:id')
  async deleteStage(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) stageId: string,
  ): Promise<{ id: string; deleted: true }> {
    const who = this.requireManager(request);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${who.tenantId}::uuid FOR UPDATE`;
      const stage = await tx.leadStage.findFirst({
        where: { tenantId: who.tenantId, id: stageId },
        select: {
          id: true,
          code: true,
          pipelineId: true,
          pipeline: { select: { isDefault: true } },
        },
      });
      if (!stage) throw notFound();
      if (stage.code !== null && stage.pipeline.isDefault)
        throw conflict('STAGE_IS_DEFAULT', 'A default stage cannot be deleted');
      const leads = await tx.lead.count({
        where: { tenantId: who.tenantId, pipelineStageId: stage.id },
      });
      if (leads > 0)
        throw conflict(
          'STAGE_HAS_LEADS',
          'Move the leads out of this stage first',
          { leadCount: leads },
        );
      await tx.leadStage.deleteMany({
        where: { tenantId: who.tenantId, id: stage.id },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorType: 'OPERATOR',
          actorId: who.operatorId,
          action: 'lead.stage.deleted',
          entityType: 'lead_stage',
          entityId: stage.id,
          safeInputSummary: {
            pipelineId: stage.pipelineId,
            code: stage.code ?? 'CUSTOM',
          },
        },
      });
      return { id: stage.id, deleted: true as const };
    });
  }

  @Get()
  async list(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<{ items: LeadPipelineItem[]; nextCursor: string | null }> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw invalidQuery();
    const {
      stageId,
      pipelineId: requestedPipeline,
      ownerOperatorId,
      source,
      closeBefore,
      closeAfter,
      cursor,
      limit,
      tagId,
      fieldKey,
      fieldValue,
    } = parsed.data;
    const tenantId = request.principal!.tenantId;
    if ((fieldKey === undefined) !== (fieldValue === undefined))
      throw invalidQuery();
    // ADR 057: the default pipeline unless a pipeline or a stage is named.
    let pipelineId = requestedPipeline;
    if (pipelineId === undefined && stageId === undefined) {
      pipelineId = (
        await this.prisma.$transaction((tx) =>
          ensureDefaultPipeline(tx, tenantId),
        )
      ).pipelineId;
    } else if (pipelineId !== undefined) {
      const found = await this.prisma.pipeline.findFirst({
        where: { tenantId, id: pipelineId },
        select: { id: true },
      });
      if (!found) throw notFound();
    }
    const field =
      fieldKey !== undefined && fieldValue !== undefined
        ? await parseFieldFilter(
            this.prisma,
            tenantId,
            'LEAD',
            fieldKey,
            fieldValue,
          )
        : undefined;
    const rows = await this.prisma.lead.findMany({
      where: {
        tenantId,
        ...(pipelineId ? { pipelineId } : {}),
        ...(stageId ? { pipelineStageId: stageId } : {}),
        ...(ownerOperatorId ? { ownerOperatorId } : {}),
        ...(source ? { source: { equals: source, mode: 'insensitive' } } : {}),
        ...(closeBefore || closeAfter
          ? {
              expectedCloseDate: {
                ...(closeBefore ? { lte: toDateOnly(closeBefore) } : {}),
                ...(closeAfter ? { gte: toDateOnly(closeAfter) } : {}),
              },
            }
          : {}),
        ...(tagId ? { tags: { some: { tenantId, tagId } } } : {}),
        ...(field
          ? { customFields: { path: [field.key], equals: field.value } }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor
        ? { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }
        : {}),
      select: {
        id: true,
        pipelineId: true,
        pipelineStageId: true,
        ownerOperatorId: true,
        amount: true,
        currency: true,
        source: true,
        expectedCloseDate: true,
        lostReason: true,
        score: true,
        status: true,
        summary: true,
        createdAt: true,
        updatedAt: true,
        customFields: true,
        contact: { select: { name: true, phone: true } },
        conversation: {
          select: {
            id: true,
            state: true,
            channelAccount: { select: { channelType: true } },
          },
        },
      },
    });
    const page = rows.slice(0, limit);
    const ownerIds = [
      ...new Set(
        page.flatMap((l) => (l.ownerOperatorId ? [l.ownerOperatorId] : [])),
      ),
    ];
    const [tags, defs, owners] = await Promise.all([
      tagsOfLeads(
        this.prisma,
        tenantId,
        page.map((l) => l.id),
      ),
      activeFieldDefs(this.prisma, tenantId, 'LEAD'),
      // One batched read for every owner on the page (no N+1).
      ownerIds.length === 0
        ? Promise.resolve([])
        : this.prisma.operator.findMany({
            where: { tenantId, id: { in: ownerIds } },
            select: { id: true, displayName: true },
          }),
    ]);
    const ownerById = new Map(owners.map((o) => [o.id, o]));
    const items: LeadPipelineItem[] = page.map(
      ({
        conversation: { channelAccount, ...conversation },
        customFields,
        amount,
        expectedCloseDate,
        ...lead
      }) => ({
        ...lead,
        amount: amount ? amount.toFixed(2) : null,
        expectedCloseDate: fromDateOnly(expectedCloseDate),
        owner: lead.ownerOperatorId
          ? (ownerById.get(lead.ownerOperatorId) ?? null)
          : null,
        conversation: {
          ...conversation,
          channelType: channelAccount.channelType,
        },
        tags: tags.get(lead.id) ?? [],
        customFields: describeFields(defs, customFields),
      }),
    );
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  /** Moves a lead to a stage; a stage of another pipeline moves the lead there. */
  @Patch(':id/stage')
  async move(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) leadId: string,
    @Body() body: unknown,
  ): Promise<{
    id: string;
    pipelineStageId: string;
    pipelineId: string;
    status: string;
  }> {
    const who = request.principal!;
    if (who.role === 'VIEWER') throw forbidden();
    const parsed = MoveBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    return this.prisma.$transaction(async (tx) => {
      const moved = await moveLeadToStage(tx, {
        tenantId: who.tenantId,
        leadId,
        stageId: parsed.data.stageId,
        actor: 'OPERATOR',
        actorId: who.operatorId,
        lostReason: parsed.data.lostReason,
      });
      return {
        id: moved.id,
        pipelineStageId: moved.pipelineStageId,
        pipelineId: moved.pipelineId,
        status: moved.status,
      };
    });
  }

  private requireManager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const { tenantId, operatorId, role } = request.principal!;
    if (role !== 'OWNER' && role !== 'ADMIN') throw forbidden();
    return { tenantId, operatorId };
  }
}
