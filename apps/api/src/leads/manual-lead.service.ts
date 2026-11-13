import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../persistence/prisma.service.js";
import { PHONE_KEY_SQL, phoneKey } from "../persons/person-merge.js";
import { upsertContactWithPerson } from "../persons/ensure-contact.js";
import {
  invalidValue,
  notFound,
  stageNotOpen,
  unknownOperator,
} from "../pipelines/pipeline-errors.js";
import { exceedsTagLimit } from "../tags/custom-field-values.js";
import { conflict as tagConflict, unknownTag } from "../tags/tag-errors.js";
import { ensureDefaultPipeline } from "./lead-stage.util.js";
import {
  chooseStage,
  MANUAL_CHANNEL_TYPE,
  manualExternalAccountId,
  manualIdentifiers,
  type ManualLeadInput,
} from "./manual-lead-rules.js";

export interface ManualLeadActor {
  readonly tenantId: string;
  readonly operatorId: string;
}

type Tx = Prisma.TransactionClient;

/**
 * Adds a lead by hand (ADR 061): internal channel account, contact (linked to
 * a person), closed conversation and the lead, all in ONE transaction.
 * Returns the new lead id; the caller reads it back with the list mapper.
 */
@Injectable()
export class ManualLeadService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    actor: ManualLeadActor,
    input: ManualLeadInput,
  ): Promise<{ leadId: string }> {
    const { tenantId, operatorId } = actor;
    return this.prisma.$transaction(async (tx) => {
      const target = await this.resolveStage(tx, tenantId, input);
      const ownerId = input.ownerOperatorId ?? operatorId;
      await this.assertActiveOperator(tx, tenantId, ownerId);
      await this.assertTags(tx, tenantId, input.tagIds);

      const ids = manualIdentifiers(randomUUID());
      // Unique across tenants (channel_type, external_account_id): the id
      // carries the tenant. ON CONFLICT keeps concurrent creates idempotent.
      const account = await tx.channelAccount.upsert({
        where: {
          channelType_externalAccountId: {
            channelType: MANUAL_CHANNEL_TYPE,
            externalAccountId: manualExternalAccountId(tenantId),
          },
        },
        create: {
          tenantId,
          channelType: MANUAL_CHANNEL_TYPE,
          externalAccountId: manualExternalAccountId(tenantId),
          status: "DISABLED",
          agentMode: "OFF",
        },
        update: {},
        select: { id: true, tenantId: true },
      });
      if (account.tenantId !== tenantId) throw notFound();

      const contactId = await this.createContact(
        tx,
        tenantId,
        account.id,
        ids.providerUserId,
        input,
      );
      const conversation = await tx.conversation.create({
        data: {
          tenantId,
          channelAccountId: account.id,
          contactId,
          providerChatId: ids.providerChatId,
          state: "CLOSED",
        },
        select: { id: true },
      });
      const lead = await tx.lead.create({
        data: {
          tenantId,
          contactId,
          conversationId: conversation.id,
          pipelineId: target.pipelineId,
          pipelineStageId: target.stageId,
          ownerOperatorId: ownerId,
          amount:
            input.amount === undefined
              ? null
              : new Prisma.Decimal(input.amount),
          currency: input.currency ?? null,
          source: input.source,
          stageSetBy: "OPERATOR",
          stageSetAt: new Date(),
          status: "NEW",
          summary: input.note,
          idempotencyKey: ids.idempotencyKey,
        },
        select: { id: true },
      });
      if (input.tagIds.length > 0)
        await tx.leadTag.createMany({
          data: input.tagIds.map((tagId) => ({
            tenantId,
            leadId: lead.id,
            tagId,
          })),
        });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: "OPERATOR",
          actorId: operatorId,
          action: "lead.created_manually",
          entityType: "lead",
          entityId: lead.id,
          // Ids only: never the name, phone or note.
          safeInputSummary: {
            stageId: target.stageId,
            pipelineId: target.pipelineId,
          },
        },
      });
      return { leadId: lead.id };
    });
  }

  private async resolveStage(
    tx: Tx,
    tenantId: string,
    input: ManualLeadInput,
  ): Promise<{ stageId: string; pipelineId: string }> {
    if (input.stageId) {
      const stage = await tx.leadStage.findFirst({
        where: {
          tenantId,
          id: input.stageId,
          archivedAt: null,
          pipeline: { archivedAt: null },
        },
        select: { id: true, pipelineId: true, kind: true },
      });
      const choice = chooseStage(stage, input.pipelineId);
      if (choice.ok) return choice;
      if (choice.code === "NOT_FOUND") throw notFound();
      if (choice.code === "STAGE_NOT_OPEN") throw stageNotOpen();
      throw invalidValue();
    }
    let pipelineId = input.pipelineId;
    if (pipelineId === undefined) {
      pipelineId = (await ensureDefaultPipeline(tx, tenantId)).pipelineId;
    } else {
      const found = await tx.pipeline.findFirst({
        where: { tenantId, id: pipelineId, archivedAt: null },
        select: { id: true },
      });
      if (!found) throw notFound();
    }
    const first = await tx.leadStage.findFirst({
      where: { tenantId, pipelineId, archivedAt: null, kind: "OPEN" },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!first) throw stageNotOpen();
    return { stageId: first.id, pipelineId };
  }

  /** FOR SHARE: a concurrent deactivation waits and then fails the check. */
  private async assertActiveOperator(
    tx: Tx,
    tenantId: string,
    operatorId: string,
  ): Promise<void> {
    const owner = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "operators"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${operatorId}::uuid AND "is_active" = true
      FOR SHARE`;
    if (owner.length === 0) throw unknownOperator();
  }

  private async assertTags(
    tx: Tx,
    tenantId: string,
    tagIds: readonly string[],
  ): Promise<void> {
    if (tagIds.length === 0) return;
    const found = await tx.tag.count({
      where: { tenantId, id: { in: [...tagIds] }, archivedAt: null },
    });
    if (found !== tagIds.length) throw unknownTag();
    if (exceedsTagLimit(tagIds.length)) throw tagConflict("TAG_LIMIT");
  }

  /**
   * The contact of the manual conversation, linked to the live person of the
   * tenant that has the same phone key (no duplicate customer, ADR 052), or
   * to a new person made by the shared helper.
   */
  private async createContact(
    tx: Tx,
    tenantId: string,
    channelAccountId: string,
    providerUserId: string,
    input: ManualLeadInput,
  ): Promise<string> {
    const personId = input.phone
      ? await this.personWithPhone(tx, tenantId, input.phone)
      : null;
    let contactId: string;
    if (personId) {
      const created = await tx.contact.create({
        data: {
          tenantId,
          channelAccountId,
          providerUserId,
          name: input.name,
          personId,
        },
        select: { id: true },
      });
      contactId = created.id;
    } else {
      contactId = (
        await upsertContactWithPerson(tx, {
          tenantId,
          channelAccountId,
          providerUserId,
          name: input.name,
        })
      ).id;
    }
    if (input.phone)
      await tx.contact.updateMany({
        where: { tenantId, id: contactId },
        data: { phone: input.phone },
      });
    return contactId;
  }

  private async personWithPhone(
    tx: Tx,
    tenantId: string,
    phone: string,
  ): Promise<string | null> {
    const key = phoneKey(phone);
    if (!key) return null;
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT p.id::text AS id
       FROM contacts c
       JOIN persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
       WHERE c.tenant_id = $1::uuid AND c.deleted_at IS NULL
         AND c.phone IS NOT NULL AND ${PHONE_KEY_SQL("c.phone")} = $2
         AND p.deleted_at IS NULL AND p.merged_into_id IS NULL
       ORDER BY p.created_at ASC, p.id ASC LIMIT 1`,
      tenantId,
      key,
    );
    return rows[0]?.id ?? null;
  }
}
