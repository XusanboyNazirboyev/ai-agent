import { PrismaService } from '../persistence/prisma.service.js';
import { parseFilterValue, type FieldValue } from './custom-field-values.js';
import { invalidQuery, invalidValue, unknownField } from './tag-errors.js';
import { activeFieldDefs } from './tag-reads.js';

export interface FieldFilter {
  key: string;
  value: FieldValue;
}

/**
 * Validates `fieldKey` + `fieldValue` of a list query against the active
 * definition of the entity (exact match on the typed value).
 */
export async function parseFieldFilter(
  prisma: PrismaService,
  tenantId: string,
  entity: 'PERSON' | 'LEAD',
  key: string,
  raw: string,
): Promise<FieldFilter> {
  if (key === '') throw invalidQuery();
  const def = (await activeFieldDefs(prisma, tenantId, entity)).find(
    (d) => d.key === key,
  );
  if (!def) throw unknownField();
  const value = parseFilterValue(def, raw);
  if (value === undefined) throw invalidValue();
  return { key, value };
}
