import type { PrismaClient } from '../generated/prisma/client.js';

export interface BackfillPersonsResult {
  contactsLinked: number;
  personsCreated: number;
  batches: number;
}

/**
 * ADR 052: give every contact that has no person its own person (1:1).
 * The migration backfills existing rows; this handles stragglers created
 * afterwards (dev scripts, tests). Idempotent and resumable: a contact is
 * only picked while `personId IS NULL`, and the link is a guarded update,
 * so a second run, or two concurrent runs, change nothing twice and leave
 * no orphan person. Batched by id cursor. `primaryPhone` stays NULL until
 * phone normalisation lands in a later slice.
 */
export async function backfillPersons(
  db: PrismaClient,
  options: { tenantId?: string; batchSize?: number } = {},
): Promise<BackfillPersonsResult> {
  const batchSize = options.batchSize ?? 500;
  const result: BackfillPersonsResult = {
    contactsLinked: 0,
    personsCreated: 0,
    batches: 0,
  };
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.contact.findMany({
      where: {
        personId: null,
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, tenantId: true, name: true, deletedAt: true },
    });
    if (batch.length === 0) break;
    result.batches += 1;
    cursor = batch[batch.length - 1]?.id;
    await db.$transaction(async (tx) => {
      for (const contact of batch) {
        const person = await tx.person.create({
          data: {
            tenantId: contact.tenantId,
            displayName: contact.name,
            deletedAt: contact.deletedAt,
          },
          select: { id: true },
        });
        const linked = await tx.contact.updateMany({
          where: { tenantId: contact.tenantId, id: contact.id, personId: null },
          data: { personId: person.id },
        });
        if (linked.count === 0) {
          await tx.person.deleteMany({
            where: { tenantId: contact.tenantId, id: person.id },
          });
        } else {
          result.contactsLinked += 1;
          result.personsCreated += 1;
        }
      }
    });
    if (batch.length < batchSize) break;
  }
  return result;
}
