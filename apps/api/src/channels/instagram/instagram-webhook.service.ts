import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import type { NormalizedInstagramText } from './instagram-normalizer.js';

const EXTERNAL_ID = /^[0-9]{1,100}$/u;

export type InstagramAcceptance = 'accepted' | 'duplicate' | 'unavailable';

@Injectable()
export class InstagramWebhookService {
  constructor(private readonly prisma: PrismaService) {}

  async accept(event: NormalizedInstagramText): Promise<InstagramAcceptance> {
    if (!EXTERNAL_ID.test(event.accountId) || !EXTERNAL_ID.test(event.customerId)) {
      throw new ServiceUnavailableException('Instagram account is unavailable');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const channel = await tx.channelAccount.findFirst({
          where: {
            channelType: 'instagram',
            externalAccountId: event.accountId,
            status: 'ACTIVE',
            tenant: { status: 'ACTIVE' },
          },
          select: { id: true, tenantId: true },
        });
        if (!channel) return 'unavailable';

        await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`instagram-rate:${channel.id}`}, 0))) AS lock_result`;

        const duplicate = await tx.inboundEvent.findUnique({
          where: {
            tenantId_channelAccountId_providerEventId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              providerEventId: event.messageId,
            },
          },
          select: { id: true },
        });
        if (duplicate) return 'duplicate';

        const inboundEvent = await tx.inboundEvent.create({
          data: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            providerEventId: event.messageId,
            receivedAt: event.receivedAt,
            redactedPayload: {
              providerAccountId: event.accountId,
              providerUserId: event.customerId,
            } satisfies Prisma.InputJsonObject,
          },
        });

        const contact = await tx.contact.upsert({
          where: {
            tenantId_channelAccountId_providerUserId: {
              tenantId: channel.tenantId,
              channelAccountId: channel.id,
              providerUserId: event.customerId,
            },
          },
          create: {
            tenantId: channel.tenantId,
            channelAccountId: channel.id,
            providerUserId: event.customerId,
          },
          update: {},
          select: { id: true },
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
            type: 'TEXT',
            text: event.text,
            sequence: (latest?.sequence ?? 0) + 1,
            providerChatId: event.customerId,
            providerMessageId: event.messageId,
            createdAt: event.receivedAt,
          },
          select: { id: true },
        });

        await tx.inboundEvent.update({
          where: { id: inboundEvent.id },
          data: {
            redactedPayload: {
              providerAccountId: event.accountId,
              providerUserId: event.customerId,
              conversationId: conversation.id,
              messageId: message.id,
            } satisfies Prisma.InputJsonObject,
          },
        });

        // The Instagram processor is intentionally not enabled yet. This
        // durable outbox record is the hand-off contract for that next stage.
        await tx.outboxEvent.create({
          data: {
            tenantId: channel.tenantId,
            type: 'instagram.inbound',
            aggregateType: 'conversation',
            aggregateId: conversation.id,
            idempotencyKey: `instagram.inbound:${channel.id}:${event.messageId}`,
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
