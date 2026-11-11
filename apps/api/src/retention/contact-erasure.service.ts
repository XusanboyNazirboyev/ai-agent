import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';

const ERASED_TEXT = '[erased]';

function erasedPlaceholder(tenantId: string, id: string): string {
  return `erased:${createHash('sha256')
    .update(`${tenantId}:${id}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 48)}`;
}

export interface ErasureResult {
  contactId: string;
  alreadyErased: boolean;
  conversations: number;
  messagesRedacted: number;
}

@Injectable()
export class ContactErasureService {
  constructor(private readonly prisma: PrismaService) {}

  async erase(
    tenantId: string,
    contactId: string,
    actorOperatorId: string,
  ): Promise<ErasureResult> {
    return this.prisma.$transaction(async (tx) => {
      const contact = await tx.contact.findFirst({
        where: { tenantId, id: contactId },
        select: { id: true, deletedAt: true },
      });
      if (!contact) throw new NotFoundException('Contact not found');

      if (contact.deletedAt) {
        return {
          contactId,
          alreadyErased: true,
          conversations: 0,
          messagesRedacted: 0,
        };
      }

      const conversations = await tx.conversation.findMany({
        where: { tenantId, contactId },
        select: { id: true },
      });
      const conversationIds = conversations.map((c) => c.id);

      let messagesRedacted = 0;
      if (conversationIds.length > 0) {
        const redacted = await tx.message.updateMany({
          where: { tenantId, conversationId: { in: conversationIds } },
          data: {
            text: ERASED_TEXT,
            mediaRef: null,
            richContent: Prisma.DbNull,
            providerMessageId: null,
            detectedLanguage: null,
            detectedScript: null,
          },
        });
        messagesRedacted = redacted.count;

        await tx.internalNote.updateMany({
          where: { tenantId, conversationId: { in: conversationIds } },
          data: { text: ERASED_TEXT },
        });

        await tx.conversationSlots.updateMany({
          where: { tenantId, conversationId: { in: conversationIds } },
          data: { slots: {} },
        });
        await tx.lead.updateMany({
          where: {
            tenantId,
            OR: [{ contactId }, { conversationId: { in: conversationIds } }],
          },
          data: { summary: '', requirements: {} },
        });
        await tx.handover.updateMany({
          where: { tenantId, conversationId: { in: conversationIds } },
          data: { summary: {} },
        });
        await tx.actionProposal.updateMany({
          where: { tenantId, conversationId: { in: conversationIds } },
          data: { payload: {}, payloadClearedAt: new Date() },
        });

        // Non-reversible, per-conversation placeholder: keeps the unique
        // (tenant, channel account, chat id) constraint satisfied and makes a
        // later message from the same person start a new contact and
        // conversation. The conversation is closed so the bot never answers
        // an erased contact.
        for (const conversationId of conversationIds) {
          const placeholder = erasedPlaceholder(tenantId, conversationId);
          await tx.message.updateMany({
            where: { tenantId, conversationId },
            data: { providerChatId: placeholder },
          });
          await tx.conversation.updateMany({
            where: { tenantId, id: conversationId },
            data: {
              providerChatId: placeholder,
              state: 'CLOSED',
              assignedOperatorId: null,
              language: null,
              script: null,
              version: { increment: 1 },
            },
          });
        }
      }

      const erasedProviderId = erasedPlaceholder(tenantId, contactId);

      await tx.contact.update({
        where: { tenantId_id: { tenantId, id: contactId } },
        data: {
          name: null,
          phone: null,
          language: null,
          script: null,
          consentStatus: 'REVOKED',
          consentAt: null,
          marketingOptOut: true,
          deletedAt: new Date(),
          providerUserId: erasedProviderId,
        },
      });

      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: actorOperatorId,
          action: 'contact.erased',
          entityType: 'contact',
          entityId: contactId,
          safeInputSummary: {
            conversations: conversationIds.length,
            messagesRedacted,
          },
        },
      });

      return {
        contactId,
        alreadyErased: false,
        conversations: conversationIds.length,
        messagesRedacted,
      };
    });
  }
}
