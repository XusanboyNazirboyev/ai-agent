import type { Prisma } from '../generated/prisma/client.js';

const ERASED_TEXT = '[erased]';

/**
 * Erasure residue of person merges (ADR 052 slice D). A person row that was
 * merged into the erased person (directly or through a chain) is a copy of
 * personal data: its name and phone are cleared and it is marked deleted, and
 * the free-text `reason` of every merge involving the erased person or that
 * lineage is replaced by `[erased]`. Runs in the caller's transaction, tenant-
 * scoped; used by the person erase and by the per-contact erase when it erases
 * the last contact of a person.
 */
export async function clearMergedLineage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  personId: string,
): Promise<{ personsCleared: number; mergesRedacted: number }> {
  const lineage = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE lineage AS (
      SELECT id FROM persons
      WHERE tenant_id = ${tenantId}::uuid AND merged_into_id = ${personId}::uuid
      UNION
      SELECT p.id FROM persons p
      JOIN lineage l ON p.merged_into_id = l.id
      WHERE p.tenant_id = ${tenantId}::uuid
    )
    SELECT id::text AS id FROM lineage`;
  const ids = lineage.map((r) => r.id);
  const involved = [personId, ...ids];
  let personsCleared = 0;
  if (ids.length > 0) {
    const cleared = await tx.person.updateMany({
      where: { tenantId, id: { in: ids } },
      data: { displayName: null, primaryPhone: null },
    });
    personsCleared = cleared.count;
    await tx.person.updateMany({
      where: { tenantId, id: { in: ids }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
  const redacted = await tx.personMerge.updateMany({
    where: {
      tenantId,
      OR: [{ survivorId: { in: involved } }, { mergedId: { in: involved } }],
    },
    data: { reason: ERASED_TEXT },
  });
  return { personsCleared, mergesRedacted: redacted.count };
}

/**
 * A merged person row copies the name and phone of the person that was merged
 * away. When every contact of that merge snapshot is erased, the copy has no
 * live owner any more, even if the survivor still has other contacts. Clears
 * the copy and the merge `reason` for the un-undone merges whose snapshot
 * contains `contactId` and has no live contact left. Call after the contact
 * itself is marked erased, in the same transaction.
 */
export async function clearErasedMergeCopies(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
): Promise<number> {
  const done = await tx.$queryRaw<Array<{ id: string }>>`
    WITH done AS (
      SELECT m.id, m.merged_id FROM person_merges m
      WHERE m.tenant_id = ${tenantId}::uuid
        AND m.undone_at IS NULL
        AND ${contactId}::uuid = ANY (m.contact_ids)
        AND NOT EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.tenant_id = ${tenantId}::uuid
            AND c.id = ANY (m.contact_ids)
            AND c.deleted_at IS NULL)
    ),
    cleared AS (
      UPDATE persons p
      SET display_name = NULL, primary_phone = NULL,
          deleted_at = COALESCE(p.deleted_at, now())
      WHERE p.tenant_id = ${tenantId}::uuid
        AND p.id IN (SELECT merged_id FROM done)
      RETURNING p.id
    ),
    redacted AS (
      UPDATE person_merges
      SET reason = ${ERASED_TEXT}
      WHERE tenant_id = ${tenantId}::uuid AND id IN (SELECT id FROM done)
      RETURNING id
    )
    SELECT id::text AS id FROM redacted`;
  return done.length;
}
