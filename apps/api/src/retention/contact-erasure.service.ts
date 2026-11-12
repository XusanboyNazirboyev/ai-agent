import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  clearErasedMergeCopies,
  clearMergedLineage,
} from '../persons/person-erasure-residue.js';

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
    return this.prisma.$transaction((tx) =>
      this.eraseInTransaction(tx, tenantId, contactId, actorOperatorId),
    );
  }

  /**
   * The erasure work of one contact, inside the caller's transaction (the
   * per-contact endpoint and the person-level erase, ADR 052 slice D, share
   * it). Nothing is committed here: a throw rolls back the whole caller.
   */
  async eraseInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    contactId: string,
    actorOperatorId: string,
  ): Promise<ErasureResult> {
    const contact = await tx.contact.findFirst({
      where: { tenantId, id: contactId },
      select: { id: true, deletedAt: true, personId: true },
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
      // The conversation is closed below, as in a normal close: an open
      // handover would still raise SLA alerts for a conversation nobody can
      // act on (handover-sla.service scans status OPEN regardless of the
      // conversation state).
      await tx.handover.updateMany({
        where: {
          tenantId,
          conversationId: { in: conversationIds },
          status: { in: ['OPEN', 'TAKEN'] },
        },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          version: { increment: 1 },
        },
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

    // ADR 052: the person copies the contact name (personal data). Clear it,
    // and mark the person deleted once none of its contacts is left.
    if (contact.personId) {
      await tx.person.updateMany({
        where: { tenantId, id: contact.personId },
        data: { displayName: null, primaryPhone: null },
      });
      const remaining = await tx.contact.count({
        where: { tenantId, personId: contact.personId, deletedAt: null },
      });
      if (remaining === 0) {
        await tx.person.updateMany({
          where: { tenantId, id: contact.personId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        await clearMergedLineage(tx, tenantId, contact.personId);
      }
    }
    // A merged-away person row copies this contact's name: clear the copy
    // once nothing of its merge snapshot is alive (even if the survivor lives).
    await clearErasedMergeCopies(tx, tenantId, contactId);
    // A merged-away person row copies this contact's name: clear the copy
    // once nothing of its merge snapshot is alive (even if the survivor lives).

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
  }
}
