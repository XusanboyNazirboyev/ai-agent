import type { Prisma } from '../generated/prisma/client.js';
import type { FieldDef } from './custom-field-values.js';

type Db = Prisma.TransactionClient;

export interface TagView {
  id: string;
  name: string;
  color: string | null;
}

/** Active tags of many persons in ONE query (no N+1). */
export async function tagsOfPersons(
  db: Db,
  tenantId: string,
  personIds: readonly string[],
): Promise<Map<string, TagView[]>> {
  const map = new Map<string, TagView[]>(personIds.map((id) => [id, []]));
  if (personIds.length === 0) return map;
  const rows = await db.personTag.findMany({
    where: {
      tenantId,
      personId: { in: [...personIds] },
      tag: { archivedAt: null },
    },
    select: {
      personId: true,
      tag: { select: { id: true, name: true, color: true } },
    },
  });
  for (const row of rows) map.get(row.personId)?.push(row.tag);
  for (const list of map.values()) sortTags(list);
  return map;
}

/** Active tags of many leads in ONE query (no N+1). */
export async function tagsOfLeads(
  db: Db,
  tenantId: string,
  leadIds: readonly string[],
): Promise<Map<string, TagView[]>> {
  const map = new Map<string, TagView[]>(leadIds.map((id) => [id, []]));
  if (leadIds.length === 0) return map;
  const rows = await db.leadTag.findMany({
    where: {
      tenantId,
      leadId: { in: [...leadIds] },
      tag: { archivedAt: null },
    },
    select: {
      leadId: true,
      tag: { select: { id: true, name: true, color: true } },
    },
  });
  for (const row of rows) map.get(row.leadId)?.push(row.tag);
  for (const list of map.values()) sortTags(list);
  return map;
}

function sortTags(list: TagView[]): void {
  list.sort(
    (a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** Active definitions of one entity, in position order. */
export async function activeFieldDefs(
  db: Db,
  tenantId: string,
  entity: 'PERSON' | 'LEAD',
): Promise<Array<FieldDef & { id: string }>> {
  const rows = await db.customFieldDef.findMany({
    where: { tenantId, entity, archivedAt: null },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      key: true,
      label: true,
      type: true,
      options: true,
      position: true,
    },
  });
  return rows.map((r) => ({
    ...r,
    options: Array.isArray(r.options) ? (r.options as string[]) : null,
  }));
}
