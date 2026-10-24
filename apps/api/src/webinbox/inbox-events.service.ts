import { Injectable } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';

export interface InboxEventRow {
  readonly id: string;
  readonly type: string;
  readonly conversationId: string | null;
  readonly handoverId: string | null;
  readonly messageId: string | null;
}

export const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Reads the per-tenant change feed written by database triggers (ADR 020). */
@Injectable()
export class InboxEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest event id of the tenant, or 0n: where a fresh stream starts. */
  async latestId(tenantId: string): Promise<bigint> {
    const row = await this.prisma.inboxEvent.findFirst({
      where: { tenantId },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    return row?.id ?? 0n;
  }

  /**
   * Events strictly after `afterId`, oldest first. `gap` is true when events the
   * client would need were pruned (it must refetch instead of trusting the stream).
   */
  async after(
    tenantId: string,
    afterId: bigint,
    limit = 100,
  ): Promise<{ events: InboxEventRow[]; gap: boolean }> {
    const rows = await this.prisma.inboxEvent.findMany({
      where: { tenantId, id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    let gap = false;
    if (afterId > 0n) {
      const oldest = await this.prisma.inboxEvent.findFirst({
        where: { tenantId },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      // Pruning removes the oldest rows; if the first retained id is beyond
      // afterId + 1 and an event existed in between, resume is lossy.
      gap =
        oldest !== null &&
        oldest.id > afterId + 1n &&
        rows[0]?.id !== afterId + 1n;
    }
    return {
      gap,
      events: rows.map((row) => ({
        id: row.id.toString(),
        type: row.type,
        conversationId: row.conversationId,
        handoverId: row.handoverId,
        messageId: row.messageId,
      })),
    };
  }

  /** Scheduled-scan entry point: housekeeping of the feed. */
  scanDue(now: Date): Promise<number> {
    return this.prune(now);
  }

  /** Deletes events older than the retention window (idempotent). */
  async prune(now = new Date()): Promise<number> {
    const result = await this.prisma.inboxEvent.deleteMany({
      where: {
        createdAt: { lt: new Date(now.getTime() - EVENT_RETENTION_MS) },
      },
    });
    return result.count;
  }
}

/** Parses Last-Event-ID / ?lastEventId; anything malformed means "no resume". */
export function parseEventId(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^\d{1,18}$/u.test(value)) return undefined;
  return BigInt(value);
}
