import type { Prisma } from '../generated/prisma/client.js';

export interface ContactIntakeInput {
  tenantId: string;
  channelAccountId: string;
  providerUserId: string;
  /** Display name from the channel; stored on create, and on update when set. */
  name?: string | null;
}

/**
 * Upsert the channel contact and make sure it has a Person (ADR 052, slice A,
 * 1:1). Must run inside the caller's transaction.
 *
 * Concurrency: the contact keeps the existing native upsert (INSERT ... ON
 * CONFLICT on the unique key), so two concurrent webhooks for the same new
 * user still yield exactly one contact. The person is created only AFTER the
 * contact row is ours, and attached with a guarded update (`personId IS
 * NULL`). If a racing writer attached a person first, the update matches
 * zero rows and the person we just created is deleted again, so no orphan
 * person is ever committed. Creating the person first would risk an orphan
 * whenever the contact insert loses the race.
 *
 * Contacts without a person (created by scripts or tests) are tolerated and
 * healed here the next time the customer writes.
 */
export async function upsertContactWithPerson(
  tx: Prisma.TransactionClient,
  input: ContactIntakeInput,
): Promise<{ id: string }> {
  const { tenantId, channelAccountId, providerUserId } = input;
  const name = input.name ?? undefined;
  const contact = await tx.contact.upsert({
    where: {
      tenantId_channelAccountId_providerUserId: {
        tenantId,
        channelAccountId,
        providerUserId,
      },
    },
    create: { tenantId, channelAccountId, providerUserId, name },
    update: name ? { name } : {},
    select: { id: true, personId: true },
  });
  if (contact.personId) return { id: contact.id };

  const person = await tx.person.create({
    data: { tenantId, displayName: name ?? null },
    select: { id: true },
  });
  const attached = await tx.contact.updateMany({
    where: { tenantId, id: contact.id, personId: null },
    data: { personId: person.id },
  });
  if (attached.count === 0) {
    await tx.person.deleteMany({ where: { tenantId, id: person.id } });
  }
  return { id: contact.id };
}
