import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import type { AccessState } from './access-decision.js';
import { TenantAccessService } from './tenant-access.service.js';

export const INBOUND_BLOCKED_ACTION = 'tenant.inbound_blocked';
export const BOT_PAUSED_EVENT = 'subscription.bot_paused';

/**
 * Inbound side of ADR 047 §3, called by the channel processor before any
 * agent turn. The customer's message is already stored by the webhook.
 * SUSPENDED/ARCHIVED: no turn, no reply, one audit event per tenant and UTC
 * day. SUBSCRIPTION_EXPIRED: no bot answer, the conversation is untouched
 * and an inbox event tells operators, who can still reply by hand.
 */
@Injectable()
export class InboundAccessGate {
  private readonly logger = new Logger(InboundAccessGate.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TenantAccessService,
  ) {}

  async state(tenantId: string, now = new Date()): Promise<AccessState> {
    return (await this.access.check(tenantId, now)).state;
  }

  /** Settles the inbound event without a turn and records why. */
  async hold(
    tenantId: string,
    inboundEventId: string,
    conversationId: string,
    state: Exclude<AccessState, 'ok'>,
    now = new Date(),
  ): Promise<void> {
    await this.prisma.inboundEvent.updateMany({
      where: { id: inboundEventId, tenantId, status: 'RECEIVED' },
      data: { status: 'PROCESSED', processedAt: now },
    });
    if (state === 'SUBSCRIPTION_EXPIRED') {
      await this.prisma.inboxEvent.create({
        data: { tenantId, type: BOT_PAUSED_EVENT, conversationId },
      });
    } else {
      const day = now.toISOString().slice(0, 10);
      const idempotencyKey = `${INBOUND_BLOCKED_ACTION}:${day}`;
      const seen = await this.prisma.auditEvent.findFirst({
        where: { tenantId, action: INBOUND_BLOCKED_ACTION, idempotencyKey },
        select: { id: true },
      });
      if (!seen)
        await this.prisma.auditEvent.create({
          data: {
            tenantId,
            actorType: 'SYSTEM',
            action: INBOUND_BLOCKED_ACTION,
            entityType: 'tenant',
            entityId: tenantId,
            idempotencyKey,
            safeInputSummary: { state },
          },
        });
    }
    this.logger.log(JSON.stringify({ event: 'inbound.held', tenantId, state }));
  }
}
