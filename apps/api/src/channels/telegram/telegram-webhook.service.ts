import {
  Injectable,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client.js';
import type { AppEnvironment } from '../../config/environment.js';
import { isOptOutMessage } from '../../core/followup/optout.js';
import { INITIAL_LOCALE_PACKS } from '../../locales/locale-packs.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import type { NormalizedTelegramText } from './telegram-normalizer.js';

const OPT_OUT_PACKS = INITIAL_LOCALE_PACKS;

export type WebhookAcceptance = 'accepted' | 'duplicate' | 'unsupported';

@Injectable()
export class TelegramWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  assertWebhookSecret(candidate: string | undefined): void {
    const configured = this.config.get('TELEGRAM_WEBHOOK_SECRET', {
      infer: true,
    });
    if (!configured) {
      throw new ServiceUnavailableException(
        'Telegram webhook is not configured',
      );
    }
    const expectedBytes = Buffer.from(configured);
    const candidateBytes = Buffer.from(candidate ?? '');
    if (
      expectedBytes.length !== candidateBytes.length ||
      !timingSafeEqual(expectedBytes, candidateBytes)
    ) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
  }

  /** The configured channel and its operator group, if the route matches. */
  async operatorChannel(
    routeAccountId: string,
  ): Promise<{ tenantId: string; operatorChatId: string | null }> {
    const configured = this.config.get('TELEGRAM_CHANNEL_ACCOUNT_ID', {
      infer: true,
    });
    if (!configured || routeAccountId !== configured) {
      throw new ServiceUnavailableException(
        'Telegram channel is not configured',
      );
    }
    const channel = await this.prisma.channelAccount.findFirst({
      where: {
        id: configured,
        channelType: 'telegram',
        status: 'ACTIVE',
        tenant: { status: 'ACTIVE' },
      },
      select: { tenantId: true, operatorChatId: true },
    });
    if (!channel) {
      throw new ServiceUnavailableException(
        'Configured Telegram channel is unavailable',
      );
    }
    return channel;
  }

  async accept(
    routeAccountId: string,
    update: NormalizedTelegramText,
  ): Promise<WebhookAcceptance> {
    const configuredAccountId = this.config.get('TELEGRAM_CHANNEL_ACCOUNT_ID', {
      infer: true,
    });
    if (!configuredAccountId || routeAccountId !== configuredAccountId) {
      throw new ServiceUnavailableException(
        'Telegram channel is not configured',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const channel = await tx.channelAccount.findFirst({
          where: {
            id: configuredAccountId,
            channelType: 'telegram',
            status: 'ACTIVE',
            tenant: { status: 'ACTIVE' },
          },
          select: { id: true, tenantId: true },
        });
        if (!channel) {
          throw new ServiceUnavailableException(
            'Configured Telegram channel is unavailable',
          );
        }

        await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`telegram-rate:${channel.id}`}, 0))) AS lock_result`;
        const duplicate = await tx.inboundEvent.findUnique({
          where: {
            tenantId_channelAccountId_providerEventId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              providerEventId: update.updateId,
            },
          },
          select: { id: true },
        });
        if (duplicate) return 'duplicate';
        const acceptedRecently = await tx.inboundEvent.count({
          where: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            receivedAt: { gte: new Date(Date.now() - 60_000) },
          },
        });
        if (
          acceptedRecently >=
          this.config.get('TELEGRAM_RATE_LIMIT_PER_MINUTE', { infer: true })
        ) {
          throw new HttpException(
            'Telegram webhook rate limit exceeded',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        const inboundEvent = await tx.inboundEvent.create({
          data: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            providerEventId: update.updateId,
            redactedPayload: {
              providerChatId: update.chatId,
              providerMessageId: update.messageId,
            } satisfies Prisma.InputJsonObject,
          },
        });

        const contact = await tx.contact.upsert({
          where: {
            tenantId_channelAccountId_providerUserId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              providerUserId: update.userId,
            },
          },
          create: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            providerUserId: update.userId,
            name: update.displayName,
          },
          update: update.displayName ? { name: update.displayName } : {},
          select: { id: true },
        });

        const conversation = await tx.conversation.upsert({
          where: {
            tenantId_channelAccountId_providerChatId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              providerChatId: update.chatId,
            },
          },
          create: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            contactId: contact.id,
            providerChatId: update.chatId,
            lastInboundAt: update.receivedAt,
          },
          update: {
            contactId: contact.id,
            lastInboundAt: update.receivedAt,
          },
          select: { id: true },
        });

        // A /stop is recorded at intake, whoever owns the conversation: it
        // must still stop reminders after an operator hands the chat back.
        if (isOptOutMessage(update.text, OPT_OUT_PACKS)) {
          const changed = await tx.contact.updateMany({
            where: {
              tenantId: channel.tenantId,
              id: contact.id,
              marketingOptOut: false,
            },
            data: { marketingOptOut: true },
          });
          if (changed.count === 1)
            await tx.auditEvent.create({
              data: {
                tenantId: channel.tenantId,
                actorType: 'CUSTOMER',
                actorId: contact.id,
                action: 'contact.opt_out',
                entityType: 'contact',
                entityId: contact.id,
                safeInputSummary: { via: 'intake' },
                idempotencyKey: `opt-out-intake:${inboundEvent.id}`,
              },
            });
        }

        // A customer writing to a closed conversation reopens it for the bot
        // (state machine: CLOSED + REOPEN -> BOT_ACTIVE).
        await tx.conversation.updateMany({
          where: {
            tenantId: channel.tenantId,
            id: conversation.id,
            state: 'CLOSED',
          },
          data: {
            state: 'BOT_ACTIVE',
            assignedOperatorId: null,
            version: { increment: 1 },
          },
        });

        // Serialize sequence allocation across webhook requests for this chat.
        await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agentcore:${channel.tenantId}:${conversation.id}`}, 0))) AS lock_result`;
        const latest = await tx.message.findFirst({
          where: {
            tenantId: channel.tenantId,
            conversationId: conversation.id,
          },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const message = await tx.message.create({
          data: {
            tenantId: channel.tenantId,
            conversationId: conversation.id,
            channelAccountId: channel.id,
            authorType: 'CUSTOMER',
            direction: 'INBOUND',
            type: 'TEXT',
            text: update.text,
            sequence: (latest?.sequence ?? 0) + 1,
            providerChatId: update.chatId,
            providerMessageId: update.messageId,
            detectedLanguage: null,
            detectedScript: null,
            createdAt: update.receivedAt,
          },
          select: { id: true },
        });

        await tx.inboundEvent.update({
          where: { id: inboundEvent.id },
          data: {
            redactedPayload: {
              providerChatId: update.chatId,
              providerMessageId: update.messageId,
              conversationId: conversation.id,
              messageId: message.id,
            } satisfies Prisma.InputJsonObject,
          },
        });

        await tx.outboxEvent.create({
          data: {
            tenantId: channel.tenantId,
            type: 'telegram.inbound',
            aggregateType: 'conversation',
            aggregateId: conversation.id,
            idempotencyKey: `telegram.inbound:${channel.id}:${update.updateId}`,
            payload: {
              inboundEventId: inboundEvent.id,
              conversationId: conversation.id,
              messageId: message.id,
            } satisfies Prisma.InputJsonObject,
          },
        });
        return 'accepted';
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return 'duplicate';
      }
      throw error;
    }
  }
}
