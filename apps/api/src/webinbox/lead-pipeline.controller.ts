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
import { parseManualLeadBody } from '../leads/manual-lead-rules.js';
import { ManualLeadService } from '../leads/manual-lead.service.js';
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
const StageKind = z.enum(['OPEN', 'WON', 'LOST']);
const StageBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    kind: StageKind.optional(),
  })
  .refine((body) => body.name !== undefined || body.kind !== undefined);
const CreateStageBody = z.object({
  name: z.string().trim().min(1).max(80),
  pipelineId: z.string().uuid().optional(),
  kind: StageKind.optional(),
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
  kind: true,
} as const;

interface LeadStageView {
  id: string;
  code: string | null;
  name: string | null;
  position: number;
  /** ADR 057 (additive). */
  pipelineId: string;
  /** ADR 058 (additive): OPEN stages are the funnel, WON/LOST are closed. */
  kind: 'OPEN' | 'WON' | 'LOST';
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
  /** ADR 058 (additive). */
  stageSetBy: 'AGENT' | 'OPERATOR';
  suggestedStageId: string | null;
  suggestedReasonCodes: string[];
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

/** Columns the list and a freshly created lead are read with. */
const LEAD_ITEM_SELECT = {
  id: true,
  pipelineId: true,
  pipelineStageId: true,
  ownerOperatorId: true,
  amount: true,
  currency: true,
  source: true,
  expectedCloseDate: true,
  lostReason: true,
  stageSetBy: true,
  suggestedStageId: true,
  suggestedReasonCodes: true,
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
} satisfies Prisma.LeadSelect;

type LeadItemRow = Prisma.LeadGetPayload<{
  select: typeof LEAD_ITEM_SELECT;
}>;

@Controller('api/v1/leads')
@UseGuards(SessionGuard)
export class LeadPipelineController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
    private readonly fields: CustomFieldsService,
    private readonly manualLeads: ManualLeadService,
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
      const kind = parsed.data.kind ?? 'OPEN';
      let position = (last?.position ?? -1) + 1;
      if (kind === 'OPEN') {
        // A new open stage goes before the closed (WON/LOST) columns, which
        // stay last, as in a CRM funnel.
        const firstClosed = await tx.leadStage.findFirst({
          where: { tenantId: who.tenantId, pipelineId, kind: { not: 'OPEN' } },
          orderBy: { position: 'asc' },
          select: { position: true },
        });
        if (firstClosed) {
          position = firstClosed.position;
          await tx.leadStage.updateMany({
            where: {
              tenantId: who.tenantId,
              pipelineId,
              position: { gte: position },
            },
            data: { position: { increment: 1 } },
          });
        }
      }
      const stage = await tx.leadStage.create({
        data: {
          tenantId: who.tenantId,
          pipelineId,
          name: parsed.data.name,
          kind,
          position,
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
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${who.tenantId}::uuid FOR UPDATE`;
      const stage = await tx.leadStage.findFirst({
        where: { tenantId: who.tenantId, id: stageId },
        select: {
          id: true,
          code: true,
          position: true,
          kind: true,
          pipelineId: true,
        },
      });
      if (!stage) throw notFound();
      const { name, kind } = parsed.data;
      if (kind !== undefined && kind !== stage.kind) {
        const leads = await tx.lead.count({
          where: { tenantId: who.tenantId, pipelineStageId: stage.id },
        });
        if (leads > 0)
          throw conflict(
            'STAGE_HAS_LEADS',
            'Move the leads out of this stage first',
            { leadCount: leads },
          );
        if (
          stage.kind === 'OPEN' &&
          (await this.otherOpen(tx, who.tenantId, stage)) === 0
        )
          throw conflict(
            'STAGE_LAST_OPEN',
            'A pipeline needs at least one open stage',
          );
      }
      const updated = await tx.leadStage.update({
        where: { tenantId_id: { tenantId: who.tenantId, id: stageId } },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(kind !== undefined ? { kind } : {}),
        },
        select: STAGE_SELECT,
      });
      await tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorType: 'OPERATOR',
          actorId: who.operatorId,
          action:
            kind !== undefined ? 'lead.stage.updated' : 'lead.stage.renamed',
          entityType: 'lead_stage',
          entityId: stage.id,
          safeInputSummary: {
            code: stage.code ?? 'CUSTOM',
            ...(kind !== undefined ? { kind } : {}),
          },
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
          kind: true,
          position: true,
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
      if (
        stage.kind === 'OPEN' &&
        (await this.otherOpen(tx, who.tenantId, stage)) === 0
      )
        throw conflict(
          'STAGE_LAST_OPEN',
          'A pipeline needs at least one open stage',
        );
      // A pending AI suggestion of this stage is dropped with it.
      await tx.lead.updateMany({
        where: { tenantId: who.tenantId, suggestedStageId: stage.id },
        data: { suggestedStageId: null, suggestedReasonCodes: [] },
      });
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

  /** Adds a lead by hand (ADR 061): OWNER, ADMIN, OPERATOR. */
  @Post()
  async createManually(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<LeadPipelineItem> {
    const who = request.principal!;
    if (who.role === 'VIEWER') throw forbidden();
    const parsed = parseManualLeadBody(body);
    if (!parsed.ok)
      throw parsed.code === 'INVALID_BODY' ? invalidBody() : invalidValue();
    const { leadId } = await this.manualLeads.create(
      { tenantId: who.tenantId, operatorId: who.operatorId },
      parsed.input,
    );
    const row = await this.prisma.lead.findFirstOrThrow({
      where: { tenantId: who.tenantId, id: leadId },
      select: LEAD_ITEM_SELECT,
    });
    const [item] = await this.toItems(who.tenantId, [row]);
    return item;
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
      select: LEAD_ITEM_SELECT,
    });
    const page = rows.slice(0, limit);
    const items = await this.toItems(tenantId, page);
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  /** Maps lead rows (selected with LEAD_ITEM_SELECT) to board/list items. */
  private async toItems(
    tenantId: string,
    page: LeadItemRow[],
  ): Promise<LeadPipelineItem[]> {
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
    return page.map(
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

  /** Number of other active OPEN stages in the stage's pipeline. */
  private otherOpen(
    tx: Prisma.TransactionClient,
    tenantId: string,
    stage: { id: string; pipelineId: string },
  ): Promise<number> {
    return tx.leadStage.count({
      where: {
        tenantId,
        pipelineId: stage.pipelineId,
        kind: 'OPEN',
        archivedAt: null,
        id: { not: stage.id },
      },
    });
  }

  /** Accepts the AI's stage suggestion: moves the lead as the operator (ADR 058). */
  @Post(':id/stage-suggestion/accept')
  async acceptSuggestion(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) leadId: string,
  ): Promise<{
    id: string;
    pipelineStageId: string;
    pipelineId: string;
    status: string;
  }> {
    const who = request.principal!;
    if (who.role === 'VIEWER') throw forbidden();
    return this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { tenantId: who.tenantId, id: leadId },
        select: { suggestedStageId: true, suggestedReasonCodes: true },
      });
      if (!lead) throw notFound();
      if (!lead.suggestedStageId) throw notFound();
      const moved = await moveLeadToStage(tx, {
        tenantId: who.tenantId,
        leadId,
        stageId: lead.suggestedStageId,
        actor: 'OPERATOR',
        actorId: who.operatorId,
        reasonCodes: lead.suggestedReasonCodes,
      });
      return {
        id: moved.id,
        pipelineStageId: moved.pipelineStageId,
        pipelineId: moved.pipelineId,
        status: moved.status,
      };
    });
  }

  @Post(':id/stage-suggestion/dismiss')
  async dismissSuggestion(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) leadId: string,
  ): Promise<{ id: string; suggestedStageId: null }> {
    const who = request.principal!;
    if (who.role === 'VIEWER') throw forbidden();
    const updated = await this.prisma.lead.updateMany({
      where: { tenantId: who.tenantId, id: leadId },
      data: { suggestedStageId: null, suggestedReasonCodes: [] },
    });
    if (updated.count === 0) throw notFound();
    return { id: leadId, suggestedStageId: null };
  }

  /** "Let the AI sort this lead": lifts the operator lock (ADR 058 decision 4). */
  @Post(':id/hand-back-to-ai')
  async handBackToAi(
    @Req() request: InboxRequest,
    @Param('id', ParseUUIDPipe) leadId: string,
  ): Promise<{ id: string; stageSetBy: 'AGENT' }> {
    const who = request.principal!;
    if (who.role === 'VIEWER') throw forbidden();
    const updated = await this.prisma.lead.updateMany({
      where: { tenantId: who.tenantId, id: leadId },
      data: { stageSetBy: 'AGENT' },
    });
    if (updated.count === 0) throw notFound();
    return { id: leadId, stageSetBy: 'AGENT' };
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
