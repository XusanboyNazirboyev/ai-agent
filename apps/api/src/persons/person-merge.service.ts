import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PeopleService } from './people.service.js';
import { canUnmerge, planMerge, type PersonState } from './person-merge.js';
import type { PersonDetail, PersonItem } from './person-view.js';

export class PersonNotFoundError extends Error {}
export class MergeRefusedError extends Error {}
export class SamePersonError extends Error {}
export class UnmergeBlockedError extends Error {}

export interface MergePreview {
  source: PersonItem;
  survivor: PersonItem;
  moves: { contacts: number; conversations: number; leads: number };
}

type Tx = Prisma.TransactionClient;

/** Person rows with their contacts, read inside the caller's transaction. */
async function loadStates(
  tx: Tx,
  tenantId: string,
  ids: string[],
): Promise<Map<string, PersonState>> {
  const rows = await tx.person.findMany({
    where: { tenantId, id: { in: ids } },
    select: {
      id: true,
      mergedIntoId: true,
      deletedAt: true,
      contacts: { select: { id: true, deletedAt: true } },
    },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Merge, preview and unmerge of persons (ADR 052 slice C). A merge is a
 * pointer change: the contacts of the source person are re-pointed to the
 * survivor; conversations, leads and bookings keep their contact. Tenant id
 * always comes from the session principal; every query is tenant-scoped.
 */
@Injectable()
export class PersonMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PeopleService,
  ) {}

  async preview(
    tenantId: string,
    sourceId: string,
    survivorId: string,
  ): Promise<MergePreview> {
    if (sourceId === survivorId) throw new SamePersonError();
    const states = await loadStates(this.prisma, tenantId, [
      sourceId,
      survivorId,
    ]);
    const source = states.get(sourceId);
    const survivor = states.get(survivorId);
    if (!source || !survivor) throw new PersonNotFoundError();
    const plan = planMerge(source, survivor);
    if (!plan.ok) throw new MergeRefusedError();
    const liveContactIds = source.contacts
      .filter((c) => c.deletedAt === null)
      .map((c) => c.id);
    const [items, conversations, leads] = await Promise.all([
      this.people.itemsByIds(tenantId, [sourceId, survivorId]),
      this.prisma.conversation.count({
        where: { tenantId, contactId: { in: liveContactIds } },
      }),
      this.prisma.lead.count({
        where: { tenantId, contactId: { in: liveContactIds } },
      }),
    ]);
    return {
      source: items[0],
      survivor: items[1],
      moves: { contacts: liveContactIds.length, conversations, leads },
    };
  }

  async merge(
    tenantId: string,
    sourceId: string,
    survivorId: string,
    reason: string,
    operatorId: string,
  ): Promise<{ mergeId: string; survivor: PersonDetail }> {
    if (sourceId === survivorId) throw new SamePersonError();
    const mergeId = await this.prisma.$transaction(async (tx) => {
      // Lock both rows in id order so two merges can never deadlock; the
      // loser re-reads the committed state and is refused.
      await tx.$queryRaw`
        SELECT id FROM persons
        WHERE tenant_id = ${tenantId}::uuid
          AND id IN (${sourceId}::uuid, ${survivorId}::uuid)
        ORDER BY id FOR UPDATE`;
      const states = await loadStates(tx, tenantId, [sourceId, survivorId]);
      const source = states.get(sourceId);
      const survivor = states.get(survivorId);
      if (!source || !survivor) throw new PersonNotFoundError();
      const plan = planMerge(source, survivor);
      if (!plan.ok) {
        if (plan.code === 'SAME_PERSON') throw new SamePersonError();
        throw new MergeRefusedError();
      }
      await tx.contact.updateMany({
        where: { tenantId, personId: sourceId, id: { in: plan.contactIds } },
        data: { personId: survivorId },
      });
      await tx.person.update({
        where: { tenantId_id: { tenantId, id: sourceId } },
        data: { mergedIntoId: survivorId },
      });
      const merge = await tx.personMerge.create({
        data: {
          tenantId,
          survivorId,
          mergedId: sourceId,
          contactIds: plan.contactIds,
          byOperatorId: operatorId,
          reason,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: operatorId,
          action: 'person.merged',
          entityType: 'person',
          entityId: sourceId,
          safeInputSummary: {
            survivorId,
            mergeId: merge.id,
            contacts: plan.contactIds.length,
          },
        },
      });
      return merge.id;
    });
    const survivor = await this.people.detail(tenantId, survivorId);
    if (!survivor) throw new PersonNotFoundError();
    return { mergeId, survivor };
  }

  async unmerge(
    tenantId: string,
    survivorId: string,
    operatorId: string,
  ): Promise<{
    mergeId: string;
    survivor: PersonDetail;
    restored: PersonItem;
  }> {
    const { mergeId, mergedId } = await this.prisma.$transaction(async (tx) => {
      const latest = await tx.personMerge.findFirst({
        where: { tenantId, survivorId, undoneAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (!latest) throw new PersonNotFoundError();
      await tx.$queryRaw`
        SELECT id FROM persons
        WHERE tenant_id = ${tenantId}::uuid
          AND id IN (${survivorId}::uuid, ${latest.mergedId}::uuid)
        ORDER BY id FOR UPDATE`;
      // Re-read under the lock: a concurrent unmerge may have won.
      const merge = await tx.personMerge.findFirst({
        where: { tenantId, id: latest.id, undoneAt: null },
      });
      if (!merge) throw new UnmergeBlockedError();
      const [survivor, mergedPerson, contacts] = await Promise.all([
        tx.person.findFirst({
          where: { tenantId, id: survivorId },
          select: { id: true, mergedIntoId: true, deletedAt: true },
        }),
        tx.person.findFirst({
          where: { tenantId, id: merge.mergedId },
          select: { mergedIntoId: true },
        }),
        tx.contact.findMany({
          where: { tenantId, id: { in: merge.contactIds } },
          select: { id: true, personId: true, deletedAt: true },
        }),
      ]);
      if (!survivor) throw new PersonNotFoundError();
      if (
        !canUnmerge({
          survivor,
          merge: { mergedId: merge.mergedId, contactIds: merge.contactIds },
          mergedPerson,
          contacts,
        })
      )
        throw new UnmergeBlockedError();
      await tx.contact.updateMany({
        where: {
          tenantId,
          personId: survivorId,
          id: { in: merge.contactIds },
        },
        data: { personId: merge.mergedId },
      });
      await tx.person.update({
        where: { tenantId_id: { tenantId, id: merge.mergedId } },
        data: { mergedIntoId: null },
      });
      await tx.personMerge.update({
        where: { id: merge.id },
        data: { undoneAt: new Date(), undoneByOperatorId: operatorId },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: operatorId,
          action: 'person.unmerged',
          entityType: 'person',
          entityId: merge.mergedId,
          safeInputSummary: {
            survivorId,
            mergeId: merge.id,
            contacts: merge.contactIds.length,
          },
        },
      });
      return { mergeId: merge.id, mergedId: merge.mergedId };
    });
    const [survivor, restored] = await Promise.all([
      this.people.detail(tenantId, survivorId),
      this.people.itemsByIds(tenantId, [mergedId]),
    ]);
    if (!survivor || restored.length === 0) throw new PersonNotFoundError();
    return { mergeId, survivor, restored: restored[0] };
  }
}
