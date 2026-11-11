import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';

const ERASED_TEXT = '[erased]';

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
      }

      const erasedProviderId = `erased:${createHash('sha256')
        .update(`${tenantId}:${contactId}:${randomUUID()}`)
        .digest('hex')
        .slice(0, 48)}`;

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
