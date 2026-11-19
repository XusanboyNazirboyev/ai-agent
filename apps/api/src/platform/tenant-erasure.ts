import type { Prisma } from '../generated/prisma/client.js';

/**
 * Deleting a tenant from the platform console (ADR 047 amendment 2026-11-17).
 * Everything the tenant owns is every base table with a `tenant_id` column,
 * read from the database catalog at delete time, so a table added later is
 * covered without a code change. Rows go children first along the foreign
 * keys that would refuse the delete (RESTRICT / NO ACTION); cascading keys
 * need no order. The platform audit log is kept: its tenant reference becomes
 * NULL with the tenant row and the entry keeps the tenant id as `entityId`.
 */
export const KEPT_TABLES: ReadonlySet<string> = new Set([
  'platform_audit_events',
]);

export interface ForeignKey {
  readonly child: string;
  readonly parent: string;
  /** `pg_constraint.confdeltype`: a NO ACTION, r RESTRICT, c CASCADE, n SET NULL, d SET DEFAULT. */
  readonly action: string;
}

export interface ErasureResult {
  /** Tenant-owned tables the delete went through. */
  readonly tables: number;
  /** Rows deleted directly (rows removed by a cascade are not counted). */
  readonly rows: number;
}

const BLOCKING = new Set(['a', 'r']);

/**
 * Tables in an order that deletes every child before a parent it references
 * through a blocking key. A table's reference to itself is resolved inside
 * its own single DELETE. A cycle between different tables cannot be ordered
 * and is refused before anything is deleted.
 */
export function deletionOrder(
  tables: readonly string[],
  keys: readonly ForeignKey[],
): string[] {
  const owned = new Set(tables);
  const children = new Map<string, Set<string>>(
    tables.map((table) => [table, new Set<string>()]),
  );
  for (const key of keys) {
    if (!BLOCKING.has(key.action) || key.child === key.parent) continue;
    if (owned.has(key.child) && owned.has(key.parent))
      children.get(key.parent)!.add(key.child);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tables.length) {
    const ready = tables
      .filter(
        (table) =>
          !done.has(table) &&
          [...children.get(table)!].every((child) => done.has(child)),
      )
      .sort();
    if (ready.length === 0)
      throw new Error(
        `tenant erasure: foreign-key cycle among ${tables
          .filter((table) => !done.has(table))
          .join(', ')}`,
      );
    for (const table of ready) {
      done.add(table);
      order.push(table);
    }
  }
  return order;
}

/**
 * A table without `tenant_id` that references tenant-owned rows through a
 * blocking key would make the delete fail half-way; it is reported instead.
 */
export function blockingOutsiders(
  tables: readonly string[],
  keys: readonly ForeignKey[],
): string[] {
  const owned = new Set([...tables, 'tenants']);
  return [
    ...new Set(
      keys
        .filter(
          (key) =>
            BLOCKING.has(key.action) &&
            owned.has(key.parent) &&
            !owned.has(key.child) &&
            !KEPT_TABLES.has(key.child),
        )
        .map((key) => `${key.child} -> ${key.parent}`),
    ),
  ].sort();
}

/** Deletes every row the tenant owns, inside the caller's transaction. */
export async function eraseTenantData(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<ErasureResult> {
  const found = await tx.$queryRaw<{ name: string }[]>`
    SELECT c.relname AS name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND a.attname = 'tenant_id'
      AND a.attnum > 0
      AND NOT a.attisdropped`;
  const keys = await tx.$queryRaw<ForeignKey[]>`
    SELECT child.relname AS child, parent.relname AS parent,
           k.confdeltype::text AS action
    FROM pg_constraint k
    JOIN pg_class child ON child.oid = k.conrelid
    JOIN pg_class parent ON parent.oid = k.confrelid
    WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace`;
  const tables = found
    .map((row) => row.name)
    .filter((name) => !KEPT_TABLES.has(name));
  const outsiders = blockingOutsiders(tables, keys);
  if (outsiders.length > 0)
    throw new Error(
      `tenant erasure: tables without tenant_id block the delete: ${outsiders.join(', ')}`,
    );
  // audit_events is append-only; its trigger lets this transaction delete
  // the rows of this tenant only (migration 20261129120000).
  await tx.$executeRaw`SELECT set_config('agentcore.erasing_tenant', ${tenantId}, true)`;
  let rows = 0;
  for (const table of deletionOrder(tables, keys)) {
    // The name comes from the catalog, never from a request; quoted anyway.
    rows += await tx.$executeRawUnsafe(
      `DELETE FROM "${table.replaceAll('"', '""')}" WHERE tenant_id = $1::uuid`,
      tenantId,
    );
  }
  return { tables: tables.length, rows };
}
