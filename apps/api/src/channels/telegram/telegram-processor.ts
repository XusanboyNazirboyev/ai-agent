import { Injectable, Logger, Optional } from '@nestjs/common';
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
import {
  InstagramAmbiguousSendError,
  InstagramApiError,
} from '../instagram/instagram-graph.js';
import { evaluateMessagingWindow } from '../instagram/instagram-messaging-window.js';
import { storedMetaId } from '../meta/meta-event-key.js';
import { VoiceTranscriptionService } from '../voice/voice-transcription.service.js';
import {
  FacebookNotConfiguredError,
  FacebookSender,
} from '../facebook/facebook-sender.js';
import {
  InstagramNotConfiguredError,
  InstagramSender,
} from '../instagram/instagram-sender.js';
import { splitInstagramText } from '../instagram/instagram-text.js';
import {
  COMMENT_PUBLIC_REPLY_EVENT,
  InstagramCommentReplyService,
} from '../instagram/instagram-comment-reply.service.js';

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
  private readonly logger = new Logger(TelegramProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: TelegramSender,
    @Optional() private readonly agent?: TelegramAgentPipeline,
    @Optional() private readonly handovers?: HandoverNotificationService,
    @Optional() private readonly shownOffers?: ShownOffersService,
    @Optional() private readonly leads?: LeadService,
    @Optional() private readonly leadSync?: LeadSyncService,
    @Optional() private readonly actions?: ActionService,
    @Optional() private readonly instagram?: InstagramSender,
    @Optional() private readonly facebook?: FacebookSender,
    @Optional() private readonly voice?: VoiceTranscriptionService,
    @Optional() private readonly comments?: InstagramCommentReplyService,
  ) {}

  async process(event: TelegramQueueEvent): Promise<ProcessResult> {
    if (event.type === 'telegram.inbound') {
      return this.processInbound(event);
    }
    if (
      event.type === 'instagram.inbound' ||
      event.type === 'facebook.inbound'
    ) {
      return this.processInstagramInbound(event);
    }
    if (event.type === 'telegram.send') {
      await this.processSend(event);
      return;
    }
    if (event.type === COMMENT_PUBLIC_REPLY_EVENT) {
      const commentRowId = jsonString(event.payload, 'commentRowId');
      if (commentRowId && this.comments)
        await this.comments.publishPublicReply(event.tenantId, commentRowId);
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
    } else if (
      event.type === 'telegram.inbound' ||
      event.type === 'instagram.inbound' ||
      event.type === 'facebook.inbound'
    ) {
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
    // ADR 042: voice notes become text (or FAILED) before anyone reads them.
    await this.voice?.resolvePending(event.tenantId, conversationId);
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

  /**
   * Instagram DM batches run through the same agent pipeline as Telegram
   * (modes, effective-mode degradation, handover, idempotent commit). With
   * the assistant OFF nothing is sent: the Phase 2 echo is Telegram-only.
   */
  private async processInstagramInbound(
    event: TelegramQueueEvent,
  ): Promise<ProcessResult> {
    const inboundEventId = jsonString(event.payload, 'inboundEventId');
    const conversationId = jsonString(event.payload, 'conversationId');
    if (!inboundEventId || !conversationId) {
      throw new Error('Invalid durable inbound event reference');
    }
    if (event.type === 'instagram.inbound')
      await this.fillInstagramName(event.tenantId, conversationId);
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
    await this.prisma.inboundEvent.updateMany({
      where: {
        id: inboundEventId,
        tenantId: event.tenantId,
        status: 'RECEIVED',
      },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
  }

  /**
   * Instagram webhooks carry only the customer's id, so the inbox showed
   * "Unnamed". Once per contact without a name, ask the User Profile API;
   * any failure leaves the name empty and never blocks the reply.
   */
  private async fillInstagramName(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    if (!this.instagram) return;
    try {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        select: {
          channelAccountId: true,
          contact: { select: { id: true, name: true, providerUserId: true } },
        },
      });
      const contact = conversation?.contact;
      if (!conversation || !contact || contact.name) return;
      const name = await this.instagram.customerName(
        tenantId,
        conversation.channelAccountId,
        contact.providerUserId,
      );
      if (!name) return;
      await this.prisma.contact.updateMany({
        where: { id: contact.id, tenantId, name: null },
        data: { name },
      });
    } catch {
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.profile_unavailable',
          conversationId,
        }),
      );
    }
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
      // A voice note that was not transcribed has no text to echo (ADR 042).
      if (batch.text.trim() === '') return;

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

  private async failMessage(
    tenantId: string,
    messageId: string,
    code: string,
    from: 'PENDING' | 'UNKNOWN',
  ): Promise<void> {
    await this.prisma.message.updateMany({
      where: { id: messageId, tenantId, deliveryState: from },
      data: { deliveryState: 'FAILED', deliveryErrorCode: code },
    });
  }

  /**
   * Instagram send (ADR 031): only inside the 24-hour window opened by the
   * customer's last message, code-decided (D4). The 7-day HUMAN_AGENT tag is
   * not used: its request field is not stated on the pages read, so an
   * operator reply past 24 hours fails instead. Replies are split into
   * 1,000-byte parts; once one part is out, a failure is never resent.
   */
  /**
   * Instagram and Messenger replies (ADR 031, ADR 040): the same 24-hour
   * window, byte-based splitting and "never resend an ambiguous send" rules;
   * only the transport and the error-code prefix differ.
   */
  private async sendMeta(
    tenantId: string,
    message: {
      readonly id: string;
      readonly text: string;
      readonly providerChatId: string;
      readonly channelAccountId: string;
      readonly authorType: 'CUSTOMER' | 'BOT' | 'OPERATOR' | 'SYSTEM';
      readonly conversation: { readonly lastInboundAt: Date | null };
    },
    kind: 'instagram' | 'facebook',
  ): Promise<void> {
    // ADR 043: the answer to a public comment is its one private reply.
    if (kind === 'instagram' && this.comments) {
      const viaComment = await this.comments.trySendPrivateReply(
        tenantId,
        message.id,
      );
      if (viaComment === 'sent') await this.afterDelivery(tenantId, message.id);
      if (viaComment !== 'not_a_comment') return;
    }
    const sender = kind === 'facebook' ? this.facebook : this.instagram;
    const window = evaluateMessagingWindow({
      lastCustomerMessageAt: message.conversation.lastInboundAt ?? undefined,
      now: new Date(),
      author: message.authorType === 'OPERATOR' ? 'human' : 'bot',
    });
    if (!window.allowed || window.tag !== 'none') {
      await this.failMessage(
        tenantId,
        message.id,
        `${kind}_window_closed`,
        'PENDING',
      );
      return;
    }
    const parts = splitInstagramText(message.text);
    if (parts.length === 0 || !sender) {
      await this.failMessage(
        tenantId,
        message.id,
        parts.length === 0 ? `${kind}_send_invalid` : `${kind}_not_configured`,
        'PENDING',
      );
      return;
    }

    const claimed = await this.prisma.message.updateMany({
      where: { id: message.id, tenantId, deliveryState: 'PENDING' },
      data: { deliveryState: 'UNKNOWN', deliveryAttempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;

    const sent: string[] = [];
    try {
      for (const part of parts) {
        const result = await sender.sendText(
          tenantId,
          message.channelAccountId,
          message.providerChatId,
          part,
        );
        sent.push(result.messageId);
      }
    } catch (error) {
      if (sent.length > 0) {
        // Part of the reply reached the customer: resending would repeat it.
        await this.failMessage(
          tenantId,
          message.id,
          `${kind}_partial_send`,
          'UNKNOWN',
        );
        return;
      }
      if (error instanceof InstagramAmbiguousSendError) {
        // Meta may have delivered it: stay UNKNOWN, never resend blindly.
        await this.prisma.message.updateMany({
          where: { id: message.id, tenantId, deliveryState: 'UNKNOWN' },
          data: { deliveryErrorCode: `${kind}_ambiguous_outcome` },
        });
        return;
      }
      if (error instanceof InstagramApiError && error.retryable) {
        await this.prisma.message.updateMany({
          where: { id: message.id, tenantId, deliveryState: 'UNKNOWN' },
          data: {
            deliveryState: 'PENDING',
            deliveryErrorCode: `${kind}_api_${error.kind}`,
          },
        });
        throw error;
      }
      await this.failMessage(
        tenantId,
        message.id,
        error instanceof InstagramApiError
          ? `${kind}_api_${error.kind}`
          : error instanceof InstagramNotConfiguredError ||
              error instanceof FacebookNotConfiguredError
            ? `${kind}_not_configured`
            : `${kind}_send_invalid`,
        'UNKNOWN',
      );
      return;
    }
    await this.prisma.message.updateMany({
      where: { id: message.id, tenantId, deliveryState: 'UNKNOWN' },
      data: {
        deliveryState: 'SENT',
        providerMessageId: sent[0] ? storedMetaId(sent[0]) : null,
        deliveryErrorCode: null,
      },
    });
    await this.afterDelivery(tenantId, message.id);
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
        authorType: true,
        channelAccount: { select: { channelType: true } },
        conversation: { select: { lastInboundAt: true } },
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
    // One send queue for every channel: the account decides the transport, so
    // a reply to an Instagram customer can never reach the Telegram sender.
    const meta = message.channelAccount.channelType;
    if (meta === 'instagram' || meta === 'facebook') {
      await this.sendMeta(event.tenantId, message, meta);
      return;
    }

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
