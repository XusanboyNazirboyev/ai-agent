import { Injectable, Logger } from '@nestjs/common';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { parseRetentionSettings } from './retention-settings.js';

const TENANT_BATCH = 50;
const DELETE_BATCH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Enforces tenant retention settings and purges expired inbound events (P0.6).
 * Idempotent, batched, tenant-scoped. Settings are read defensively; unknown
 * or missing values mean "keep".
 */
@Injectable()
export class RetentionService implements ScheduledScan {
  private readonly logger = new Logger(RetentionService.name);
  /** Conversations whose purge failed during the current run (counted, never silent). */
  protected failedConversations = 0;

  constructor(private readonly prisma: PrismaService) {}

  async scanDue(now: Date): Promise<number> {
    let total = 0;
    this.failedConversations = 0;
    let cursor: string | undefined;
    for (;;) {
      const tenants = await this.prisma.tenant.findMany({
        where: { status: { not: 'ARCHIVED' } },
        select: { id: true, retentionSettings: true },
        orderBy: { id: 'asc' },
        take: TENANT_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (tenants.length === 0) break;
      for (const tenant of tenants) {
        total += await this.scanTenantRow(tenant, now);
      }
      cursor = tenants[tenants.length - 1]?.id;
      if (tenants.length < TENANT_BATCH) break;
    }
    if (total > 0 || this.failedConversations > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'retention.purge',
          deleted: total,
          failedConversations: this.failedConversations,
        }),
      );
    }
    return total;
  }

  /** Purges one tenant; used by scheduled scans and deterministic tests. */
  async scanTenant(tenantId: string, now: Date): Promise<number> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, retentionSettings: true },
    });
    if (!tenant) return 0;
    return this.scanTenantRow(tenant, now);
  }

  private async scanTenantRow(
    tenant: { id: string; retentionSettings: unknown },
    now: Date,
  ): Promise<number> {
    const settings = parseRetentionSettings(tenant.retentionSettings);
    return this.purgeTenant(tenant.id, settings, now);
  }

  private async purgeTenant(
    tenantId: string,
    settings: ReturnType<typeof parseRetentionSettings>,
    now: Date,
  ): Promise<number> {
    let deleted = 0;
    deleted += await this.purgeInboundEvents(tenantId, settings, now);
    deleted += await this.purgeMessages(tenantId, settings, now);
    deleted += await this.purgeConversations(tenantId, settings, now);
    return deleted;
  }

  private async purgeInboundEvents(
    tenantId: string,
    settings: ReturnType<typeof parseRetentionSettings>,
    now: Date,
  ): Promise<number> {
    const receivedBefore =
      settings.inboundEventMinutes === null
        ? null
        : new Date(now.getTime() - settings.inboundEventMinutes * 60_000);
    let total = 0;
    for (;;) {
      const rows = await this.prisma.inboundEvent.findMany({
        where: {
          tenantId,
          status: { in: ['PROCESSED', 'FAILED'] },
          OR: [
            { expiresAt: { lte: now } },
            ...(receivedBefore
              ? [{ expiresAt: null, receivedAt: { lt: receivedBefore } }]
              : []),
          ],
        },
        select: { id: true },
        take: DELETE_BATCH,
      });
      if (rows.length === 0) break;
      const result = await this.prisma.inboundEvent.deleteMany({
        where: { tenantId, id: { in: rows.map((r) => r.id) } },
      });
      total += result.count;
      if (rows.length < DELETE_BATCH) break;
    }
    return total;
  }

  /**
   * Purges old messages but never the newest message (highest sequence) of a
   * conversation, so `sequence` (and the agent reply idempotency key built
   * from it) never restarts. Candidate selection excludes the newest message
   * by itself, so each batch makes progress and the loop terminates.
   */
  private async purgeMessages(
    tenantId: string,
    settings: ReturnType<typeof parseRetentionSettings>,
    now: Date,
  ): Promise<number> {
    if (settings.messageDays === null) return 0;
    const cutoff = new Date(now.getTime() - settings.messageDays * DAY_MS);
    let total = 0;
    for (;;) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT m.id FROM messages m
        WHERE m.tenant_id = ${tenantId}::uuid
          AND m.created_at < ${cutoff}
          AND EXISTS (
            SELECT 1 FROM messages n
            WHERE n.tenant_id = m.tenant_id
              AND n.conversation_id = m.conversation_id
              AND n.sequence > m.sequence)
        ORDER BY m.id
        LIMIT ${DELETE_BATCH}`;
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      const deleted = await this.prisma.$transaction(async (tx) => {
        // Only quotes.shown_in_message_id has a database foreign key (Restrict);
        // the other message_id columns are plain references, cleaned here so
        // nothing points at a purged message.
        await tx.quote.updateMany({
          where: { tenantId, shownInMessageId: { in: ids } },
          data: { shownInMessageId: null },
        });
        await tx.agentTurn.updateMany({
          where: { tenantId, replyMessageId: { in: ids } },
          data: { replyMessageId: null },
        });
        await tx.followUp.updateMany({
          where: { tenantId, messageId: { in: ids } },
          data: { messageId: null },
        });
        await tx.shownOffer.deleteMany({
          where: { tenantId, messageId: { in: ids } },
        });
        await tx.instagramComment.deleteMany({
          where: { tenantId, messageId: { in: ids } },
        });
        const result = await tx.message.deleteMany({
          where: { tenantId, id: { in: ids } },
        });
        return result.count;
      });
      total += deleted;
      if (deleted === 0 || rows.length < DELETE_BATCH) break;
    }
    return total;
  }

  /**
   * Purges old CLOSED conversations that have no messages and no leads.
   * Leads are CRM records and are never deleted here. Handovers, quotes and
   * other child rows go with the conversation through the schema's cascade;
   * appointments (Restrict) are detached. A cursor guarantees progress, and a
   * failing conversation is logged (ids only) and skipped.
   */
  private async purgeConversations(
    tenantId: string,
    settings: ReturnType<typeof parseRetentionSettings>,
    now: Date,
  ): Promise<number> {
    if (settings.conversationDays === null) return 0;
    const cutoff = new Date(now.getTime() - settings.conversationDays * DAY_MS);
    let total = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.conversation.findMany({
        where: {
          tenantId,
          updatedAt: { lt: cutoff },
          state: 'CLOSED',
          messages: { none: {} },
          leads: { none: {} },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: DELETE_BATCH,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          total += await this.purgeOneConversation(tenantId, row.id);
        } catch {
          this.failedConversations += 1;
          this.logger.warn(
            JSON.stringify({
              event: 'retention.conversation_purge_failed',
              tenantId,
              conversationId: row.id,
            }),
          );
        }
      }
      cursor = rows[rows.length - 1]?.id;
      if (rows.length < DELETE_BATCH) break;
    }
    return total;
  }

  protected async purgeOneConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await tx.appointment.updateMany({
        where: { tenantId, conversationId },
        data: { conversationId: null },
      });
      const result = await tx.conversation.deleteMany({
        where: { tenantId, id: conversationId },
      });
      return result.count;
    });
  }
}
