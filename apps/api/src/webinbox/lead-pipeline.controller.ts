import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../persistence/prisma.service.js";
import { ensureLeadStages } from "../leads/lead-stage.util.js";
import {
  describeFields,
  type FieldValue,
} from "../tags/custom-field-values.js";
import {
  CustomFieldsService,
  type FieldValueView,
} from "../tags/custom-fields.service.js";
import { parseFieldFilter } from "../tags/field-filter.js";
import { invalidQuery } from "../tags/tag-errors.js";
import {
  activeFieldDefs,
  tagsOfLeads,
  type TagView,
} from "../tags/tag-reads.js";
import { TagsService } from "../tags/tags.service.js";
import { SessionGuard, type InboxRequest } from "./session.guard.js";
import {
  operating,
  parseId,
  parseTagIds,
  parseValues,
} from "./tag-assignment.js";

const ListQuery = z.object({
  stageId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  tagId: z.string().uuid().optional(),
  fieldKey: z.string().max(64).optional(),
  fieldValue: z.string().max(600).optional(),
});
const StageBody = z.object({ name: z.string().trim().min(1).max(80) });
const MoveBody = z.object({ stageId: z.string().uuid() });
const MAX_STAGES = 20;

interface LeadStageView {
  id: string;
  code: string | null;
  name: string | null;
  position: number;
}

interface LeadPipelineItem {
  id: string;
  pipelineStageId: string | null;
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

@Controller("api/v1/leads")
@UseGuards(SessionGuard)
export class LeadPipelineController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
    private readonly fields: CustomFieldsService,
  ) {}

  /** Replaces the tag set of a lead (ADR 053). */
  @Put(":id/tags")
  async setTags(
    @Req() request: InboxRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ tags: TagView[] }> {
    const principal = operating(request);
    const tagIds = parseTagIds(body);
    return this.tags.setTags(
      principal.tenantId,
      principal.operatorId,
      "lead",
      parseId(id),
      tagIds,
    );
  }

  /** Merges custom field values into a lead (ADR 053). */
  @Patch(":id/custom-fields")
  async setCustomFields(
    @Req() request: InboxRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ customFields: FieldValueView[] }> {
    const principal = operating(request);
    const values = parseValues(body);
    return this.fields.patchValues(
      principal.tenantId,
      principal.operatorId,
      "lead",
      parseId(id),
      values,
    );
  }

  @Get("stages")
  async stages(@Req() request: InboxRequest): Promise<LeadStageView[]> {
    const tenantId = request.principal!.tenantId;
    await this.prisma.$transaction((tx) =>
      ensureLeadStages(tx, tenantId).then(() => undefined),
    );
    return this.prisma.leadStage.findMany({
      where: { tenantId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, code: true, name: true, position: true },
    });
  }

  @Post("stages")
  async createStage(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<LeadStageView> {
    const who = this.requireManager(request);
    const parsed = StageBody.safeParse(body);
    if (!parsed.success) throw this.invalidBody();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${who.tenantId}::uuid FOR UPDATE`;
      await ensureLeadStages(tx, who.tenantId);
      const count = await tx.leadStage.count({
        where: { tenantId: who.tenantId },
      });
      if (count >= MAX_STAGES)
        throw new ConflictException({
          code: "LEAD_STAGE_LIMIT",
          message: "Maximum number of lead stages reached",
          i18nKey: "errors.LEAD_STAGE_LIMIT",
        });
      const last = await tx.leadStage.findFirst({
        where: { tenantId: who.tenantId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const stage = await tx.leadStage.create({
        data: {
          tenantId: who.tenantId,
          name: parsed.data.name,
          position: (last?.position ?? -1) + 1,
        },
        select: { id: true, code: true, name: true, position: true },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorType: "OPERATOR",
          actorId: who.operatorId,
          action: "lead.stage.created",
          entityType: "lead_stage",
          entityId: stage.id,
          safeInputSummary: { position: String(stage.position) },
        },
      });
      return stage;
    });
  }

  @Patch("stages/:id")
  async renameStage(
    @Req() request: InboxRequest,
    @Param("id", ParseUUIDPipe) stageId: string,
    @Body() body: unknown,
  ): Promise<LeadStageView> {
    const who = this.requireManager(request);
    const parsed = StageBody.safeParse(body);
    if (!parsed.success) throw this.invalidBody();
    return this.prisma.$transaction(async (tx) => {
      const stage = await tx.leadStage.findFirst({
        where: { tenantId: who.tenantId, id: stageId },
        select: { id: true, code: true, position: true },
      });
      if (!stage) throw this.notFound();
      const updated = await tx.leadStage.update({
        where: { tenantId_id: { tenantId: who.tenantId, id: stageId } },
        data: { name: parsed.data.name },
        select: { id: true, code: true, name: true, position: true },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorType: "OPERATOR",
          actorId: who.operatorId,
          action: "lead.stage.renamed",
          entityType: "lead_stage",
          entityId: stage.id,
          safeInputSummary: { code: stage.code ?? "CUSTOM" },
        },
      });
      return updated;
    });
  }

  @Get()
  async list(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<{ items: LeadPipelineItem[]; nextCursor: string | null }> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        code: "INVALID_QUERY",
        message: "Invalid query",
        i18nKey: "errors.invalidQuery",
      });
    const { stageId, cursor, limit, tagId, fieldKey, fieldValue } = parsed.data;
    const tenantId = request.principal!.tenantId;
    if ((fieldKey === undefined) !== (fieldValue === undefined))
      throw invalidQuery();
    const field =
      fieldKey !== undefined && fieldValue !== undefined
        ? await parseFieldFilter(
            this.prisma,
            tenantId,
            "LEAD",
            fieldKey,
            fieldValue,
          )
        : undefined;
    const rows = await this.prisma.lead.findMany({
      where: {
        tenantId,
        ...(stageId ? { pipelineStageId: stageId } : {}),
        ...(tagId ? { tags: { some: { tenantId, tagId } } } : {}),
        ...(field
          ? { customFields: { path: [field.key], equals: field.value } }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor
        ? { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }
        : {}),
      select: {
        id: true,
        pipelineStageId: true,
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
    const [tags, defs] = await Promise.all([
      tagsOfLeads(
        this.prisma,
        tenantId,
        page.map((l) => l.id),
      ),
      activeFieldDefs(this.prisma, tenantId, "LEAD"),
    ]);
    const items: LeadPipelineItem[] = page.map(
      ({
        conversation: { channelAccount, ...conversation },
        customFields,
        ...lead
      }) => ({
        ...lead,
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

  @Patch(":id/stage")
  async move(
    @Req() request: InboxRequest,
    @Param("id", ParseUUIDPipe) leadId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; pipelineStageId: string }> {
    const who = request.principal!;
    if (who.role === "VIEWER") throw this.forbidden();
    const parsed = MoveBody.safeParse(body);
    if (!parsed.success) throw this.invalidBody();
    return this.prisma.$transaction(async (tx) => {
      const [lead, stage] = await Promise.all([
        tx.lead.findFirst({
          where: { tenantId: who.tenantId, id: leadId },
          select: { id: true, pipelineStageId: true },
        }),
        tx.leadStage.findFirst({
          where: { tenantId: who.tenantId, id: parsed.data.stageId },
          select: { id: true },
        }),
      ]);
      if (!lead || !stage) throw this.notFound();
      if (lead.pipelineStageId !== stage.id) {
        await tx.lead.update({
          where: { tenantId_id: { tenantId: who.tenantId, id: leadId } },
          data: { pipelineStageId: stage.id },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: who.tenantId,
            actorType: "OPERATOR",
            actorId: who.operatorId,
            action: "lead.stage.changed",
            entityType: "lead",
            entityId: lead.id,
            safeInputSummary: {
              fromStageId: lead.pipelineStageId ?? "",
              toStageId: stage.id,
            },
          },
        });
      }
      return { id: lead.id, pipelineStageId: stage.id };
    });
  }

  private requireManager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const { tenantId, operatorId, role } = request.principal!;
    if (role !== "OWNER" && role !== "ADMIN") throw this.forbidden();
    return { tenantId, operatorId };
  }

  private invalidBody(): BadRequestException {
    return new BadRequestException({
      code: "INVALID_BODY",
      message: "Invalid request body",
      i18nKey: "errors.invalidBody",
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: "NOT_FOUND",
      message: "Not found",
      i18nKey: "errors.NOT_FOUND",
    });
  }

  private forbidden(): ForbiddenException {
    return new ForbiddenException({
      code: "FORBIDDEN",
      message: "Not allowed",
      i18nKey: "errors.forbidden",
    });
  }
}
