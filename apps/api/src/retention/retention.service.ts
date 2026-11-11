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

  constructor(private readonly prisma: PrismaService) {}

  async scanDue(now: Date): Promise<number> {
    let total = 0;
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
        const settings = parseRetentionSettings(tenant.retentionSettings);
        total += await this.purgeTenant(tenant.id, settings, now);
      }
      cursor = tenants[tenants.length - 1]?.id;
      if (tenants.length < TENANT_BATCH) break;
    }
    if (total > 0) {
      this.logger.log(
        JSON.stringify({ event: 'retention.purge', deleted: total }),
      );
    }
    return total;
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

  private async purgeMessages(
    tenantId: string,
    settings: ReturnType<typeof parseRetentionSettings>,
    now: Date,
  ): Promise<number> {
    if (settings.messageDays === null) return 0;
    const cutoff = new Date(now.getTime() - settings.messageDays * DAY_MS);
    let total = 0;
    for (;;) {
      const rows = await this.prisma.message.findMany({
        where: { tenantId, createdAt: { lt: cutoff } },
        select: { id: true },
        take: DELETE_BATCH,
      });
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      await this.prisma.quote.updateMany({
        where: { tenantId, shownInMessageId: { in: ids } },
        data: { shownInMessageId: null },
      });
      await this.prisma.agentTurn.updateMany({
        where: { tenantId, replyMessageId: { in: ids } },
        data: { replyMessageId: null },
      });
      await this.prisma.followUp.updateMany({
        where: { tenantId, messageId: { in: ids } },
        data: { messageId: null },
      });
      await this.prisma.shownOffer.deleteMany({
        where: { tenantId, messageId: { in: ids } },
      });
      await this.prisma.instagramComment.deleteMany({
        where: { tenantId, messageId: { in: ids } },
      });
      const result = await this.prisma.message.deleteMany({
        where: { tenantId, id: { in: ids } },
      });
      total += result.count;
      if (rows.length < DELETE_BATCH) break;
    }
    return total;
  }

  private async purgeConversations(
    tenantId: string,
    settings: ReturnType<typeof parseRetentionSettings>,
    now: Date,
  ): Promise<number> {
    if (settings.conversationDays === null) return 0;
    const cutoff = new Date(now.getTime() - settings.conversationDays * DAY_MS);
    let total = 0;
    for (;;) {
      const rows = await this.prisma.conversation.findMany({
        where: {
          tenantId,
          updatedAt: { lt: cutoff },
          state: 'CLOSED',
        },
        select: { id: true },
        take: DELETE_BATCH,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        const msgCount = await this.prisma.message.count({
          where: { tenantId, conversationId: row.id },
        });
        if (msgCount > 0) continue;
        await this.prisma.lead
          .deleteMany({
            where: { tenantId, conversationId: row.id },
          })
          .catch(() => undefined);
        await this.prisma.handover
          .deleteMany({
            where: { tenantId, conversationId: row.id },
          })
          .catch(() => undefined);
        await this.prisma.quote
          .deleteMany({
            where: { tenantId, conversationId: row.id },
          })
          .catch(() => undefined);
        await this.prisma.appointment
          .updateMany({
            where: { tenantId, conversationId: row.id },
            data: { conversationId: null },
          })
          .catch(() => undefined);
        const result = await this.prisma.conversation
          .deleteMany({
            where: { tenantId, id: row.id },
          })
          .catch(() => ({ count: 0 }));
        total += result.count;
      }
      if (rows.length < DELETE_BATCH) break;
    }
    return total;
  }
}
