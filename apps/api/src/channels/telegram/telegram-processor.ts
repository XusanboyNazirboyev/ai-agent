import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
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

function jsonString(value: Prisma.JsonValue, key: string): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const field = value[key];
    return typeof field === 'string' ? field : null;
  }
  return null;
}

function compareProviderIds(left: string, right: string): number {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

@Injectable()
export class TelegramProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: TelegramSender,
  ) {}

  async process(event: TelegramQueueEvent): Promise<void> {
    if (event.type === 'telegram.inbound') {
      await this.processInbound(event);
      return;
    }
    if (event.type === 'telegram.send') {
      await this.processSend(event);
      return;
    }
    throw new Error('Unsupported Telegram queue event');
  }

  async markExhausted(event: TelegramQueueEvent): Promise<void> {
    if (event.type === 'telegram.inbound') {
      const inboundEventId = jsonString(event.payload, 'inboundEventId');
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

  private async processInbound(event: TelegramQueueEvent): Promise<void> {
    const inboundEventId = jsonString(event.payload, 'inboundEventId');
    const conversationId = jsonString(event.payload, 'conversationId');
    if (!inboundEventId || !conversationId) {
      throw new Error('Invalid durable inbound event reference');
    }

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

      const pending = await tx.inboundEvent.findMany({
        where: {
          tenantId: event.tenantId,
          channelAccountId: initial.channelAccountId,
          status: 'RECEIVED',
          redactedPayload: {
            path: ['conversationId'],
            equals: conversationId,
          },
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      const candidates = pending
        .map((candidate) => ({
          event: candidate,
          messageId: jsonString(candidate.redactedPayload, 'providerMessageId'),
          storedMessageId: jsonString(candidate.redactedPayload, 'messageId'),
        }))
        .filter(
          (
            candidate,
          ): candidate is typeof candidate & {
            messageId: string;
            storedMessageId: string;
          } => Boolean(candidate.messageId && candidate.storedMessageId),
        )
        .sort((a, b) => compareProviderIds(a.messageId, b.messageId));

      if (candidates.length === 0) return;
      const previous = await tx.inboundEvent.findFirst({
        where: {
          tenantId: event.tenantId,
          channelAccountId: initial.channelAccountId,
          status: 'PROCESSED',
          redactedPayload: {
            path: ['conversationId'],
            equals: conversationId,
          },
        },
        orderBy: { processedAt: 'desc' },
      });
      const cursor = previous
        ? jsonString(previous.redactedPayload, 'providerMessageId')
        : null;
      const late = cursor
        ? candidates.filter(
            (candidate) => compareProviderIds(candidate.messageId, cursor) <= 0,
          )
        : [];
      for (const candidate of late) {
        await tx.inboundEvent.updateMany({
          where: {
            id: candidate.event.id,
            tenantId: event.tenantId,
            status: 'RECEIVED',
          },
          data: { status: 'FAILED' },
        });
      }
      let batch = candidates
        .filter((candidate) => !late.includes(candidate))
        .slice(0, 4);
      if (batch.length === 0) return;

      const messages = await tx.message.findMany({
        where: {
          id: { in: batch.map((candidate) => candidate.storedMessageId) },
          tenantId: event.tenantId,
          direction: 'INBOUND',
        },
        select: { id: true, text: true, sequence: true },
      });
      const messageById = new Map(
        messages.map((message) => [message.id, message]),
      );
      const orderedMessages = batch
        .map((candidate) => messageById.get(candidate.storedMessageId))
        .filter((message) => message !== undefined);
      if (orderedMessages.length !== batch.length) {
        throw new Error('Durable inbound message is missing');
      }

      let responseText = '';
      let fitCount = 0;
      for (const message of orderedMessages) {
        const nextText = responseText
          ? `${responseText}\n${message.text}`
          : message.text;
        if (nextText.length > 4_096) break;
        responseText = nextText;
        fitCount += 1;
      }
      batch = batch.slice(0, fitCount);
      if (batch.length === 0)
        throw new Error('Inbound text exceeds Telegram reply limit');

      const batchTime = new Date();
      await tx.inboundEvent.updateMany({
        where: {
          id: { in: batch.map((candidate) => candidate.event.id) },
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
          text: responseText,
          sequence: (latest?.sequence ?? 0) + 1,
          providerChatId: conversation.providerChatId,
          deliveryState: 'PENDING',
          sendIdempotencyKey: `telegram-reply:${conversationId}:${batch.at(-1)?.messageId}`,
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
    } catch (error) {
      if (error instanceof TelegramAmbiguousSendError) {
        await this.prisma.message.updateMany({
          where: { id: message.id, tenantId: event.tenantId },
          data: { deliveryErrorCode: 'telegram_ambiguous_outcome' },
        });
        return;
      }
      if (error instanceof TelegramApiError) {
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
