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
