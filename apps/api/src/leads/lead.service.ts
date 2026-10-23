import { Injectable } from '@nestjs/common';
import type { DomainPack } from '@agentcore/shared';
import { Prisma } from '../generated/prisma/client.js';
import { DOMAIN_PACKS } from '../agent/agent-conversation.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { scoreLead, type LeadLevel } from '../core/leads/scoring.js';

type Tx = Prisma.TransactionClient;

/** Key-order independent JSON (PostgreSQL JSONB does not keep key order). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );
}

export interface LeadUpdate {
  readonly leadId: string;
  readonly level: LeadLevel;
  readonly created: boolean;
  readonly changed: boolean;
}

/**
 * Local-first lead capture. A lead row is the system of record: it is written
 * in the same transaction as the signals that justify it, scored with the
 * Domain Pack's deterministic rules (reason codes always stored), and is
 * never lost when the CRM is down. A CRM sync is queued separately and its
 * outcome is recorded on the row (see LeadSyncService). One lead per
 * conversation (idempotency key), so retries never duplicate it.
 */
@Injectable()
export class LeadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Stores a phone number the customer wrote (only if the contact has none). */
  async capturePhone(
    tx: Tx,
    tenantId: string,
    contactId: string,
    phone: string,
  ): Promise<boolean> {
    const updated = await tx.contact.updateMany({
      where: { tenantId, id: contactId, phone: null },
      data: { phone },
    });
    return updated.count === 1;
  }

  /** Re-scores from a committed turn's slots and intent (inside its transaction). */
  async rescoreFromTurn(
    tx: Tx,
    input: {
      tenantId: string;
      conversationId: string;
      slots: Readonly<Record<string, { value: string | number }>>;
      intent?: string;
    },
  ): Promise<LeadUpdate | undefined> {
    const tenant = await tx.tenant.findFirst({
      where: { id: input.tenantId },
      select: { packKey: true, packVersion: true },
    });
    const pack = tenant
      ? DOMAIN_PACKS.get(`${tenant.packKey}@${tenant.packVersion}`)
      : undefined;
    if (!pack) return undefined;
    return this.rescore(tx, { ...input, pack });
  }

  /** Re-scores from stored state (after a delivery); no new intent signal. */
  async rescoreConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<LeadUpdate | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { packKey: true, packVersion: true },
      });
      const pack = tenant
        ? DOMAIN_PACKS.get(`${tenant.packKey}@${tenant.packVersion}`)
        : undefined;
      if (!pack) return undefined;
      const slots = await tx.conversationSlots.findFirst({
        where: { tenantId, conversationId },
        orderBy: { version: 'desc' },
        select: { slots: true },
      });
      return this.rescore(tx, {
        tenantId,
        conversationId,
        pack,
        slots: ((
          slots?.slots as {
            slots?: Record<string, { value: string | number }>;
          } | null
        )?.slots ?? {}) as Record<string, { value: string | number }>,
      });
    });
  }

  /**
   * Re-scores the conversation and creates or updates its lead. A COLD
   * conversation without an open handover does not create a lead. The score
   * can rise or fall with the evidence, but reason codes always match it.
   */
  async rescore(
    tx: Tx,
    input: {
      tenantId: string;
      conversationId: string;
      pack: DomainPack;
      slots: Readonly<Record<string, { value: string | number }>>;
      intent?: string;
      summaryHint?: string;
    },
  ): Promise<LeadUpdate | undefined> {
    const scoring = input.pack.leadScoring;
    if (!scoring) return undefined;
    const conversation = await tx.conversation.findFirst({
      where: { tenantId: input.tenantId, id: input.conversationId },
      select: {
        contactId: true,
        contact: { select: { phone: true, name: true } },
      },
    });
    if (!conversation) return undefined;
    const [shown, openHandover, existing] = await Promise.all([
      tx.shownOffer.findMany({
        where: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
        },
        select: { facts: true, quoteRecorded: true },
      }),
      tx.handover.count({
        where: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          status: { in: ['OPEN', 'TAKEN'] },
        },
      }),
      tx.lead.findFirst({
        where: {
          tenantId: input.tenantId,
          idempotencyKey: `lead:${input.conversationId}`,
        },
      }),
    ]);
    const slotValues = Object.fromEntries(
      Object.entries(input.slots).map(([key, entry]) => [key, entry.value]),
    );
    const quoteShown = shown.some(
      (offer) =>
        offer.quoteRecorded ||
        (Array.isArray(offer.facts) &&
          (
            offer.facts as Array<{
              value?: { kind?: string; confirmedQuote?: boolean };
            }>
          ).some(
            (fact) =>
              fact.value?.kind === 'price' &&
              fact.value.confirmedQuote === true,
          )),
    );
    const computed = scoreLead(scoring, {
      slots: slotValues,
      intent: input.intent,
      hasPhone: Boolean(conversation.contact.phone),
      offerShown: shown.length > 0,
      quoteShown,
    });
    // Evidence only accumulates: a reason that once held (e.g. the customer
    // asked to book) is not dropped because a later turn lacked the signal.
    const known = new Set([
      ...computed.reasonCodes,
      ...(existing?.reasonCodes ?? []),
    ]);
    const reasonCodes = scoring.rules
      .filter((rule) => known.has(rule.code))
      .map((rule) => rule.code);
    const points = scoring.rules
      .filter((rule) => known.has(rule.code))
      .reduce((sum, rule) => sum + rule.points, 0);
    const result = {
      points,
      reasonCodes,
      level: (points >= scoring.hot
        ? 'HOT'
        : points >= scoring.warm
          ? 'WARM'
          : 'COLD') as LeadLevel,
    };
    if (result.level === 'COLD' && openHandover === 0 && !existing)
      return undefined;
    const summary = [
      `${result.level} (${result.points}): ${result.reasonCodes.join(', ') || 'no reasons'}`,
      Object.entries(slotValues)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', '),
    ]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 1_000);
    const requirements = slotValues as Prisma.InputJsonObject;
    if (!existing) {
      const created = await tx.lead.create({
        data: {
          tenantId: input.tenantId,
          contactId: conversation.contactId,
          conversationId: input.conversationId,
          score: result.level,
          reasonCodes: [...result.reasonCodes],
          summary,
          requirements,
          idempotencyKey: `lead:${input.conversationId}`,
        },
        select: { id: true },
      });
      await this.queueSync(
        tx,
        input.tenantId,
        created.id,
        result.level,
        result.reasonCodes,
      );
      return {
        leadId: created.id,
        level: result.level,
        created: true,
        changed: true,
      };
    }
    const changed =
      existing.score !== result.level ||
      existing.reasonCodes.join(',') !== result.reasonCodes.join(',') ||
      canonical(existing.requirements) !== canonical(slotValues);
    if (changed) {
      await tx.lead.update({
        where: { id: existing.id },
        data: {
          score: result.level,
          reasonCodes: [...result.reasonCodes],
          summary,
          requirements,
          // The CRM copy is stale until the next sync succeeds.
          crmSyncStatus:
            existing.crmSyncStatus === 'NOT_REQUIRED'
              ? 'NOT_REQUIRED'
              : 'PENDING',
        },
      });
      await this.queueSync(
        tx,
        input.tenantId,
        existing.id,
        result.level,
        result.reasonCodes,
      );
    }
    return {
      leadId: existing.id,
      level: result.level,
      created: false,
      changed,
    };
  }

  private async queueSync(
    tx: Tx,
    tenantId: string,
    leadId: string,
    level: string,
    reasons: readonly string[],
  ): Promise<void> {
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          type: 'crm.lead.sync',
          aggregateType: 'lead',
          aggregateId: leadId,
          idempotencyKey: `crm.lead.sync:${leadId}:${level}:${reasons.join('+')}`,
          payload: { leadId } satisfies Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
  }
}
