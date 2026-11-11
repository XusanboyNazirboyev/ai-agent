import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import {
  inboundEventExpiresAt,
  parseRetentionSettings,
} from '../../retention/retention-settings.js';
import { metaInboundKey, storedMetaId } from '../meta/meta-event-key.js';
import { parseCarouselPayload, readCarousel } from './instagram-carousel.js';
import { upsertContactWithPerson } from '../../persons/ensure-contact.js';
import type {
  NormalizedInstagramComment,
  NormalizedInstagramPostback,
  NormalizedInstagramText,
  NormalizedInstagramVoice,
} from './instagram-normalizer.js';

/** How many recent carousels a tap is matched against. */
const RECENT_CAROUSELS = 20;

const EXTERNAL_ID = /^[0-9]{1,100}$/u;

export type InstagramAcceptance = 'accepted' | 'duplicate' | 'unavailable';

/** Meta channels that share this durable intake (Instagram, Messenger). */
export type MetaChannelType = 'instagram' | 'facebook';

@Injectable()
export class InstagramWebhookService {
  constructor(private readonly prisma: PrismaService) {}

  async accept(
    event: NormalizedInstagramText | NormalizedInstagramVoice,
    channelType: MetaChannelType = 'instagram',
  ): Promise<InstagramAcceptance> {
    if (
      !EXTERNAL_ID.test(event.accountId) ||
      !EXTERNAL_ID.test(event.customerId)
    ) {
      throw new ServiceUnavailableException(
        channelType === 'facebook'
          ? 'Facebook Page is unavailable'
          : 'Instagram account is unavailable',
      );
    }

    const storedId = storedMetaId(event.messageId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const channel = await tx.channelAccount.findFirst({
          where: {
            channelType,
            externalAccountId: event.accountId,
            status: 'ACTIVE',
            tenant: { status: 'ACTIVE' },
          },
          select: {
            id: true,
            tenantId: true,
            tenant: { select: { retentionSettings: true } },
          },
        });
        if (!channel) return 'unavailable';

        await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${channelType}-rate:${channel.id}`}, 0))) AS lock_result`;

        const duplicate = await tx.inboundEvent.findUnique({
          where: {
            tenantId_channelAccountId_providerEventId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              providerEventId: storedId,
            },
          },
          select: { id: true },
        });
        if (duplicate) return 'duplicate';

        const inboundEvent = await tx.inboundEvent.create({
          data: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            providerEventId: storedId,
            receivedAt: event.receivedAt,
            expiresAt: inboundEventExpiresAt(
              parseRetentionSettings(channel.tenant.retentionSettings),
              event.receivedAt,
            ),
            redactedPayload: {
              providerAccountId: event.accountId,
              providerUserId: event.customerId,
            } satisfies Prisma.InputJsonObject,
          },
        });

        const contact = await upsertContactWithPerson(tx, {
          tenantId: channel.tenantId,
          channelAccountId: channel.id,
          providerUserId: event.customerId,
        });

        const conversation = await tx.conversation.upsert({
          where: {
            tenantId_channelAccountId_providerChatId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              providerChatId: event.customerId,
            },
          },
          create: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            contactId: contact.id,
            providerChatId: event.customerId,
            lastInboundAt: event.receivedAt,
          },
          update: {
            contactId: contact.id,
            lastInboundAt: event.receivedAt,
          },
          select: { id: true },
        });

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
            ...(event.kind === 'voice'
              ? {
                  // ADR 042: the audio is fetched from this URL by the worker
                  // (never at intake, never from a stored, long-lived link).
                  type: 'VOICE' as const,
                  text: '',
                  voiceStatus: 'PENDING' as const,
                  mediaRef: event.url,
                }
              : { type: 'TEXT' as const, text: event.text }),
            sequence: (latest?.sequence ?? 0) + 1,
            providerChatId: event.customerId,
            providerMessageId: storedId,
            createdAt: event.receivedAt,
          },
          select: { id: true, sequence: true },
        });

        await tx.inboundEvent.update({
          where: { id: inboundEvent.id },
          data: {
            redactedPayload: {
              providerAccountId: event.accountId,
              providerUserId: event.customerId,
              conversationId: conversation.id,
              messageId: message.id,
              providerMessageId: storedId,
              // Batch order (inbound-batch.ts): Meta's mid is opaque, our
              // per-conversation sequence is assigned under the lock above.
              orderKey: String(message.sequence),
            } satisfies Prisma.InputJsonObject,
          },
        });

        // Durable hand-off to the queue processor (telegram-processor.ts).
        await tx.outboxEvent.create({
          data: {
            tenantId: channel.tenantId,
            type: `${channelType}.inbound`,
            aggregateType: 'conversation',
            aggregateId: conversation.id,
            idempotencyKey: metaInboundKey(
              channelType,
              channel.id,
              event.messageId,
            ),

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

  /**
   * ADR 044: a carousel tap becomes an ordinary inbound text message. The
   * payload is untrusted: it counts only when it names an item of a carousel
   * we sent in this customer's conversation (tenant- and conversation-
   * scoped, from our own stored spec). The text is rebuilt from that spec
   * ("<button label>: <item title>", both code-rendered from facts), so
   * nothing from the tap reaches the agent except the matched item. Any
   * other tap is ignored. Dedupe is the postback `mid`, like a message.
   */
  async acceptPostback(
    event: NormalizedInstagramPostback,
  ): Promise<InstagramAcceptance | 'ignored'> {
    const itemId = parseCarouselPayload(event.payload);
    if (
      !itemId ||
      !EXTERNAL_ID.test(event.accountId) ||
      !EXTERNAL_ID.test(event.customerId)
    )
      return 'ignored';
    const channel = await this.prisma.channelAccount.findFirst({
      where: {
        channelType: 'instagram',
        externalAccountId: event.accountId,
        status: 'ACTIVE',
        tenant: { status: 'ACTIVE' },
      },
      select: { id: true, tenantId: true },
    });
    if (!channel) return 'unavailable';
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        tenantId: channel.tenantId,
        channelAccountId: channel.id,
        providerChatId: event.customerId,
      },
      select: { id: true },
    });
    if (!conversation) return 'ignored';
    const sent = await this.prisma.message.findMany({
      where: {
        tenantId: channel.tenantId,
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        richContent: { not: Prisma.DbNull },
      },
      orderBy: { sequence: 'desc' },
      take: RECENT_CAROUSELS,
      select: { richContent: true },
    });
    for (const row of sent) {
      const spec = readCarousel(row.richContent);
      const item = spec?.items.find((candidate) => candidate.id === itemId);
      if (spec && item)
        return this.accept({
          kind: 'text',
          messageId: event.messageId,
          accountId: event.accountId,
          customerId: event.customerId,
          text: `${spec.label}: ${item.title}`,
          receivedAt: event.receivedAt,
        });
    }
    return 'ignored';
  }

  /**
   * ADR 043: a top-level comment enters the commenter's DM conversation as an
   * inbound COMMENT message (its text is untrusted customer text) and runs
   * through the same agent pipeline. It never opens the 24-hour messaging
   * window (`lastInboundAt` is left alone): the only allowed answer is one
   * private reply to the comment, sent by the processor. Comment ids that
   * are not plain digits are not accepted.
   */
  async acceptComment(
    event: NormalizedInstagramComment,
  ): Promise<InstagramAcceptance | 'ignored'> {
    if (
      !EXTERNAL_ID.test(event.accountId) ||
      !EXTERNAL_ID.test(event.fromId) ||
      !EXTERNAL_ID.test(event.commentId)
    ) {
      return 'ignored';
    }
    const mediaId =
      event.mediaId && EXTERNAL_ID.test(event.mediaId) ? event.mediaId : null;
    const providerKey = `comment:${event.commentId}`;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const channel = await tx.channelAccount.findFirst({
          where: {
            channelType: 'instagram',
            externalAccountId: event.accountId,
            status: 'ACTIVE',
            tenant: { status: 'ACTIVE' },
          },
          select: {
            id: true,
            tenantId: true,
            tenant: { select: { retentionSettings: true } },
          },
        });
        if (!channel) return 'unavailable';

        await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`instagram-rate:${channel.id}`}, 0))) AS lock_result`;

        const duplicate = await tx.instagramComment.findUnique({
          where: {
            tenantId_channelAccountId_commentId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              commentId: event.commentId,
            },
          },
          select: { id: true },
        });
        if (duplicate) return 'duplicate';

        const inboundEvent = await tx.inboundEvent.create({
          data: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            providerEventId: providerKey,
            receivedAt: event.receivedAt,
            expiresAt: inboundEventExpiresAt(
              parseRetentionSettings(channel.tenant.retentionSettings),
              event.receivedAt,
            ),
            redactedPayload: {
              providerAccountId: event.accountId,
              providerUserId: event.fromId,
            } satisfies Prisma.InputJsonObject,
          },
        });

        const contact = await upsertContactWithPerson(tx, {
          tenantId: channel.tenantId,
          channelAccountId: channel.id,
          providerUserId: event.fromId,
        });

        const conversation = await tx.conversation.upsert({
          where: {
            tenantId_channelAccountId_providerChatId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              providerChatId: event.fromId,
            },
          },
          create: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            contactId: contact.id,
            providerChatId: event.fromId,
          },
          update: { contactId: contact.id },
          select: { id: true },
        });

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
            type: 'COMMENT',
            text: event.text,
            sequence: (latest?.sequence ?? 0) + 1,
            providerChatId: event.fromId,
            providerMessageId: providerKey,
            createdAt: event.receivedAt,
          },
          select: { id: true, sequence: true },
        });

        await tx.instagramComment.create({
          data: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            conversationId: conversation.id,
            messageId: message.id,
            commentId: event.commentId,
            mediaId,
            mediaProductType: event.mediaProductType,
            commentedAt: event.receivedAt,
          },
        });

        await tx.inboundEvent.update({
          where: { id: inboundEvent.id },
          data: {
            redactedPayload: {
              providerAccountId: event.accountId,
              providerUserId: event.fromId,
              conversationId: conversation.id,
              messageId: message.id,
              providerMessageId: providerKey,
              orderKey: String(message.sequence),
            } satisfies Prisma.InputJsonObject,
          },
        });

        await tx.outboxEvent.create({
          data: {
            tenantId: channel.tenantId,
            type: 'instagram.inbound',
            aggregateType: 'conversation',
            aggregateId: conversation.id,
            idempotencyKey: metaInboundKey(
              'instagram',
              channel.id,
              providerKey,
            ),
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
