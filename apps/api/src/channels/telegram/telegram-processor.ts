import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { jsonString, selectInboundBatch } from './inbound-batch.js';
import {
  HandoverNotificationService,
  isHandoverEvent,
} from '../../handover/handover-notification.service.js';
import { LeadService } from '../../leads/lead.service.js';
import { ActionService } from '../../actions/action.service.js';
import { LeadSyncService } from '../../leads/lead-sync.service.js';
import { ShownOffersService } from '../../leads/shown-offers.service.js';
import { TelegramAgentPipeline } from './telegram-agent-pipeline.js';
import {
  TelegramAmbiguousSendError,
  TelegramApiError,
  TelegramSender,
} from './telegram-sender.js';

export type TelegramQueueEvent = {
  outboxId: string;
  tenantId: string;
  type: string;
  payload: Prisma.JsonValue;
};

/** The conversation is busy with another worker's turn: retry later. */
export type ProcessResult = void | { readonly retryAt: Date };

@Injectable()
export class TelegramProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: TelegramSender,
    @Optional() private readonly agent?: TelegramAgentPipeline,
    @Optional() private readonly handovers?: HandoverNotificationService,
    @Optional() private readonly shownOffers?: ShownOffersService,
    @Optional() private readonly leads?: LeadService,
    @Optional() private readonly leadSync?: LeadSyncService,
    @Optional() private readonly actions?: ActionService,
  ) {}

  async process(event: TelegramQueueEvent): Promise<ProcessResult> {
    if (event.type === 'telegram.inbound') {
      return this.processInbound(event);
    }
    if (event.type === 'telegram.send') {
      await this.processSend(event);
      return;
    }
    if (event.type === 'action.execute') {
      const proposalId = jsonString(event.payload, 'proposalId');
      if (proposalId && this.actions)
        await this.actions.execute(event.tenantId, proposalId);
      return;
    }
    if (event.type === 'crm.lead.sync') {
      const leadId = jsonString(event.payload, 'leadId');
      if (leadId && this.leadSync)
        await this.leadSync.sync(event.tenantId, leadId);
      return;
    }
    if (isHandoverEvent(event.type) && this.handovers) {
      await this.handovers.process(event);
      return;
    }
    throw new Error('Unsupported Telegram queue event');
  }

  async markExhausted(event: TelegramQueueEvent): Promise<void> {
    if (isHandoverEvent(event.type)) {
      await this.handovers?.markExhausted(event);
    } else if (event.type === 'telegram.inbound') {
      const inboundEventId = jsonString(event.payload, 'inboundEventId');
      // An agent turn owned by this job can no longer finish.
      await this.agent?.failOwnedTurns(event);
      if (inboundEventId) {
        await this.prisma.inboundEvent.updateMany({
          where: {
            id: inboundEventId,
            tenantId: event.tenantId,
            status: { in: ['RECEIVED', 'PROCESSING'] },
          },
          data: { status: 'FAILED' },
        });
      }
    } else if (event.type === 'telegram.send') {
      const messageId = jsonString(event.payload, 'messageId');
      if (messageId) {
        await this.prisma.message.updateMany({
          where: {
            id: messageId,
            tenantId: event.tenantId,
            deliveryState: 'PENDING',
          },
          data: {
            deliveryState: 'FAILED',
            deliveryErrorCode: 'telegram_retries_exhausted',
          },
        });
      }
    }
    await this.prisma.outboxEvent.updateMany({
      where: { id: event.outboxId, tenantId: event.tenantId },
      data: { status: 'FAILED', attempts: 5 },
    });
  }

  private async processInbound(
    event: TelegramQueueEvent,
  ): Promise<ProcessResult> {
    const inboundEventId = jsonString(event.payload, 'inboundEventId');
    const conversationId = jsonString(event.payload, 'conversationId');
    if (!inboundEventId || !conversationId) {
      throw new Error('Invalid durable inbound event reference');
    }
    if (this.agent) {
      const mode = await this.agent.modeFor(event.tenantId, conversationId);
      if (mode !== 'OFF') {
        return this.agent.run(event, {
          inboundEventId,
          conversationId,
          requestedMode: mode,
        });
      }
    }
    await this.processEcho(event, inboundEventId, conversationId);
  }

  /** Phase 2 behavior (agent mode OFF): one echo per debounced batch. */
  private async processEcho(
    event: TelegramQueueEvent,
    inboundEventId: string,
    conversationId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agentcore:${event.tenantId}:${conversationId}`}, 0))) AS lock_result`;
      const initial = await tx.inboundEvent.findFirst({
        where: {
          id: inboundEventId,
          tenantId: event.tenantId,
          status: 'RECEIVED',
        },
        select: { channelAccountId: true },
      });
      if (!initial) return;

      const batch = await selectInboundBatch(
        tx,
        event.tenantId,
        initial.channelAccountId,
        conversationId,
      );
      if (!batch) return;

      const batchTime = new Date();
      await tx.inboundEvent.updateMany({
        where: {
          id: { in: [...batch.eventIds] },
          tenantId: event.tenantId,
          status: 'RECEIVED',
        },
        data: { status: 'PROCESSED', processedAt: batchTime },
      });

      const conversation = await tx.conversation.findFirst({
        where: { tenantId: event.tenantId, id: conversationId },
        select: {
          id: true,
          state: true,
          channelAccountId: true,
          providerChatId: true,
        },
      });
      if (!conversation || conversation.state !== 'BOT_ACTIVE') return;

      const latest = await tx.message.findFirst({
        where: { tenantId: event.tenantId, conversationId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const reply = await tx.message.create({
        data: {
          tenantId: event.tenantId,
          conversationId,
          channelAccountId: conversation.channelAccountId,
          authorType: 'BOT',
          direction: 'OUTBOUND',
          type: 'TEXT',
          text: batch.text,
          sequence: (latest?.sequence ?? 0) + 1,
          providerChatId: conversation.providerChatId,
          deliveryState: 'PENDING',
          sendIdempotencyKey: `telegram-reply:${conversationId}:${batch.lastProviderMessageId}`,
        },
        select: { id: true },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId: event.tenantId,
          type: 'telegram.send',
          aggregateType: 'message',
          aggregateId: reply.id,
          idempotencyKey: `telegram.send:${reply.id}`,
          payload: { messageId: reply.id } satisfies Prisma.InputJsonObject,
        },
      });
    });
  }

  /**
   * Offers-shown and lead updates run only after Telegram accepted the
   * message. A failure here must not re-send the message, so it is logged and
   * left to the next delivery-independent rescore.
   */
  private async afterDelivery(
    tenantId: string,
    messageId: string,
  ): Promise<void> {
    try {
      const recorded = await this.shownOffers?.recordDelivered(
        tenantId,
        messageId,
      );
      if (recorded) {
        const message = await this.prisma.message.findFirst({
          where: { id: messageId, tenantId },
          select: { conversationId: true },
        });
        if (message)
          await this.leads?.rescoreConversation(
            tenantId,
            message.conversationId,
          );
      }
    } catch (error) {
      void error; // never fail a delivered message
    }
  }

  private async markBlocked(
    tenantId: string,
    messageId: string,
  ): Promise<void> {
    const row = await this.prisma.message.findFirst({
      where: { id: messageId, tenantId },
      select: { conversation: { select: { contactId: true } } },
    });
    const contactId = row?.conversation.contactId;
    if (!contactId) return;
    await this.prisma.contact.updateMany({
      where: { tenantId, id: contactId },
      data: { marketingOptOut: true },
    });
    await this.prisma.auditEvent
      .create({
        data: {
          tenantId,
          actorType: 'SYSTEM',
          action: 'telegram.bot_blocked',
          entityType: 'contact',
          entityId: contactId,
          safeInputSummary: { messageId },
          idempotencyKey: `bot-blocked:${messageId}`,
        },
      })
      .catch(() => undefined); // already recorded for this message
  }

  private async processSend(event: TelegramQueueEvent): Promise<void> {
    const messageId = jsonString(event.payload, 'messageId');
    if (!messageId)
      throw new Error('Invalid durable outbound message reference');
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, tenantId: event.tenantId },
      select: {
        id: true,
        text: true,
        providerChatId: true,
        channelAccountId: true,
        deliveryState: true,
      },
    });
    if (
      !message ||
      message.deliveryState === 'SENT' ||
      message.deliveryState === 'FAILED'
    ) {
      return;
    }
    if (message.deliveryState === 'UNKNOWN') return;

    const claimed = await this.prisma.message.updateMany({
      where: {
        id: message.id,
        tenantId: event.tenantId,
        deliveryState: 'PENDING',
      },
      data: { deliveryState: 'UNKNOWN', deliveryAttempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;

    try {
      const result = await this.sender.sendMessage(
        message.providerChatId,
        message.text,
        message.channelAccountId,
      );
      await this.prisma.message.updateMany({
        where: {
          id: message.id,
          tenantId: event.tenantId,
          deliveryState: 'UNKNOWN',
        },
        data: {
          deliveryState: 'SENT',
          providerMessageId: result.messageId,
          deliveryErrorCode: null,
        },
      });
      await this.afterDelivery(event.tenantId, message.id);
    } catch (error) {
      if (error instanceof TelegramAmbiguousSendError) {
        await this.prisma.message.updateMany({
          where: { id: message.id, tenantId: event.tenantId },
          data: { deliveryErrorCode: 'telegram_ambiguous_outcome' },
        });
        return;
      }
      if (error instanceof TelegramApiError) {
        // 403: the customer blocked the bot or deleted the chat. Never message
        // them again (reminders stop), and keep the fact in the audit log.
        if (error.errorCode === 403)
          await this.markBlocked(event.tenantId, message.id);
        const retryable = error.errorCode === 429 || error.errorCode >= 500;
        await this.prisma.message.updateMany({
          where: { id: message.id, tenantId: event.tenantId },
          data: {
            deliveryState: retryable ? 'PENDING' : 'FAILED',
            deliveryErrorCode: `telegram_api_${error.errorCode}`,
          },
        });
        if (retryable) throw error;
        return;
      }
      await this.prisma.message.updateMany({
        where: { id: message.id, tenantId: event.tenantId },
        data: {
          deliveryState: 'FAILED',
          deliveryErrorCode: 'telegram_send_invalid',
        },
      });
      throw error;
    }
  }
}
