import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { nextState } from '../core/handover/state-machine.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { lockConversation } from './conversation-lock.js';

/** Messages the bot answers at once after a return (the pipeline's batch size). */
const MAX_REPLAYED = 4;

const INBOUND_EVENT_TYPE: Record<string, string> = {
  telegram: 'telegram.inbound',
  instagram: 'instagram.inbound',
  facebook: 'facebook.inbound',
};

/**
 * Idle operator (ADR 038 amendment 1): a conversation an operator holds goes
 * back to the bot when the customer's latest message has had no reply for
 * OPERATOR_IDLE_RETURN_MINUTES (and the operator took it at least that long
 * ago). The customer's unanswered messages are queued again, so the bot
 * answers them as if they had just arrived. 0 turns it off.
 */
@Injectable()
export class OperatorIdleReturnService {
  private readonly logger = new Logger(OperatorIdleReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  get minutes(): number {
    return (
      this.config.get('OPERATOR_IDLE_RETURN_MINUTES', { infer: true }) ?? 2
    );
  }

  async scanDue(now: Date): Promise<number> {
    if (this.minutes <= 0) return 0;
    return this.scan(now, this.minutes);
  }

  async scan(
    now: Date,
    minutes: number,
    options: { limit?: number; tenantId?: string } = {},
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - minutes * 60_000);
    const tenantFilter = options.tenantId
      ? Prisma.sql`AND c.tenant_id = ${options.tenantId}::uuid`
      : Prisma.empty;
    const candidates = await this.prisma.$queryRaw<
      Array<{ id: string; tenantId: string; version: number }>
    >(Prisma.sql`
      SELECT c.id AS id, c.tenant_id AS "tenantId", c.version AS version
      FROM conversations c
      JOIN tenants t ON t.id = c.tenant_id AND t.status = 'ACTIVE'
      JOIN LATERAL (
        SELECT m.direction, m.created_at
        FROM messages m
        WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
        ORDER BY m.sequence DESC
        LIMIT 1
      ) last ON true
      WHERE c.state = 'OPERATOR_ACTIVE'
        AND last.direction = 'INBOUND'
        AND last.created_at <= ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM handovers h
          WHERE h.tenant_id = c.tenant_id AND h.conversation_id = c.id
            AND h.status = 'TAKEN' AND h.taken_at > ${cutoff}
        )
        ${tenantFilter}
      ORDER BY last.created_at ASC
      LIMIT ${options.limit ?? 50}
    `);
    let returned = 0;
    for (const candidate of candidates) {
      if (await this.returnToBot(candidate, minutes)) returned += 1;
    }
    return returned;
  }

  private async returnToBot(
    candidate: { id: string; tenantId: string; version: number },
    minutes: number,
  ): Promise<boolean> {
    const { tenantId, id: conversationId } = candidate;
    return this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, tenantId, conversationId);
      const conversation = await tx.conversation.findFirst({
        where: { tenantId, id: conversationId },
        select: {
          state: true,
          version: true,
          assignedOperatorId: true,
          channelAccountId: true,
          channelAccount: { select: { channelType: true } },
        },
      });
      // Re-checked under the lock: an operator reply or command in between wins.
      if (
        !conversation ||
        conversation.state !== 'OPERATOR_ACTIVE' ||
        conversation.version !== candidate.version
      )
        return false;
      const next = nextState(conversation.state, 'RETURN_TO_BOT');
      if (!next) return false;
      const recent = await tx.message.findMany({
        where: { tenantId, conversationId },
        orderBy: { sequence: 'desc' },
        take: MAX_REPLAYED + 1,
        select: { id: true, direction: true },
      });
      const unanswered: string[] = [];
      for (const message of recent) {
        if (message.direction !== 'INBOUND') break;
        unanswered.push(message.id);
      }
      if (unanswered.length === 0) return false;
      unanswered.splice(MAX_REPLAYED);

      const moved = await tx.conversation.updateMany({
        where: {
          tenantId,
          id: conversationId,
          state: 'OPERATOR_ACTIVE',
          version: conversation.version,
        },
        data: {
          state: next,
          assignedOperatorId: null,
          version: { increment: 1 },
        },
      });
      if (moved.count !== 1) return false;
      await tx.handover.updateMany({
        where: {
          tenantId,
          conversationId,
          status: { in: ['OPEN', 'TAKEN'] },
        },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          version: { increment: 1 },
        },
      });

      // The pipeline closed these events while the operator held the
      // conversation; RECEIVED again, they form the bot's next batch.
      const events = await tx.inboundEvent.findMany({
        where: {
          tenantId,
          channelAccountId: conversation.channelAccountId,
          status: 'PROCESSED',
          OR: unanswered.map((messageId) => ({
            redactedPayload: { path: ['messageId'], equals: messageId },
          })),
        },
        select: { id: true, redactedPayload: true },
      });
      const latestId = unanswered[0]!;
      const latest = events.find(
        (event) =>
          (event.redactedPayload as Record<string, unknown> | null)
            ?.messageId === latestId,
      );
      const type = INBOUND_EVENT_TYPE[conversation.channelAccount.channelType];
      const key = `idle-return:${conversationId}:${conversation.version}`;
      if (latest && type) {
        await tx.inboundEvent.updateMany({
          where: {
            tenantId,
            id: { in: events.map((event) => event.id) },
            status: 'PROCESSED',
          },
          data: { status: 'RECEIVED', processedAt: null },
        });
        await tx.outboxEvent.create({
          data: {
            tenantId,
            type,
            aggregateType: 'conversation',
            aggregateId: conversationId,
            idempotencyKey: key,
            payload: {
              inboundEventId: latest.id,
              conversationId,
              messageId: latestId,
            } satisfies Prisma.InputJsonObject,
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'SYSTEM',
          action: 'system.operator_idle_return',
          entityType: 'conversation',
          entityId: conversationId,
          safeInputSummary: {
            from: 'OPERATOR_ACTIVE',
            state: next,
            minutes,
            replayed: latest && type ? events.length : 0,
          },
          idempotencyKey: key,
        },
      });
      this.logger.log(
        JSON.stringify({
          event: 'handover.operator_idle_return',
          tenant: tenantId,
          conversation: conversationId,
          replayed: latest && type ? events.length : 0,
        }),
      );
      return true;
    });
  }
}
