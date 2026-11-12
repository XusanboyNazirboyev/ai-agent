import { Injectable } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { ContactErasureService } from '../retention/contact-erasure.service.js';
import { clearMergedLineage } from './person-erasure-residue.js';
import { PersonNotFoundError } from './person-merge.service.js';

export interface PersonErasureResult {
  personId: string;
  contacts: number;
  conversations: number;
  messagesRedacted: number;
}

/**
 * Owner-initiated erasure of a whole person (ADR 052 slice D): every
 * non-erased contact goes through the ADR 049 contact erasure inside ONE
 * transaction (a failure leaves nothing half erased), then the person is
 * cleared and the merged-lineage residue is removed.
 */
@Injectable()
export class PersonErasureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contactErasure: ContactErasureService,
  ) {}

  async erase(
    tenantId: string,
    personId: string,
    actorOperatorId: string,
  ): Promise<PersonErasureResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM persons
        WHERE tenant_id = ${tenantId}::uuid AND id = ${personId}::uuid
        FOR UPDATE`;
      const person = await tx.person.findFirst({
        where: { tenantId, id: personId, deletedAt: null, mergedIntoId: null },
        select: {
          id: true,
          contacts: {
            where: { deletedAt: null },
            select: { id: true },
            orderBy: { id: 'asc' },
          },
        },
      });
      if (!person || person.contacts.length === 0)
        throw new PersonNotFoundError();
      let conversations = 0;
      let messagesRedacted = 0;
      for (const contact of person.contacts) {
        const result = await this.contactErasure.eraseInTransaction(
          tx,
          tenantId,
          contact.id,
          actorOperatorId,
        );
        conversations += result.conversations;
        messagesRedacted += result.messagesRedacted;
      }
      // Normally already done by the last contact erase; keeps the person
      // consistent whatever the contact order or state was.
      await tx.person.updateMany({
        where: { tenantId, id: personId },
        data: { displayName: null, primaryPhone: null },
      });
      await tx.person.updateMany({
        where: { tenantId, id: personId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await clearMergedLineage(tx, tenantId, personId);
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: actorOperatorId,
          action: 'person.erased',
          entityType: 'person',
          entityId: personId,
          safeInputSummary: {
            contacts: person.contacts.length,
            conversations,
            messagesRedacted,
          },
        },
      });
      return {
        personId,
        contacts: person.contacts.length,
        conversations,
        messagesRedacted,
      };
    });
  }
}
