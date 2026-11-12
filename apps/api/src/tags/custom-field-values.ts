/**
 * Pure rules of tags and custom fields (ADR 053). No database access: the
 * services load plain rows and ask these functions.
 */

export const TAG_COLORS = [
  'gray',
  'blue',
  'green',
  'amber',
  'red',
  'purple',
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const TAG_NAME_MAX = 40;
export const MAX_TAGS_PER_ENTITY = 20;
export const MAX_ACTIVE_TAGS = 200;
export const MAX_ACTIVE_FIELDS = 50;
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const FIELD_LABEL_MAX = 80;
export const TEXT_VALUE_MAX = 500;
export const OPTIONS_MAX = 50;
export const OPTION_MAX_LENGTH = 60;

export type FieldType = 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'SELECT';
export type FieldValue = string | number | boolean;

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  position: number;
}

export function isValidFieldKey(key: string): boolean {
  return FIELD_KEY_PATTERN.test(key);
}

export function isTagColor(value: unknown): value is TagColor {
  return (
    typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value)
  );
}

/** Trimmed tag name, or null when empty or longer than the limit. */
export function normalizeTagName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= TAG_NAME_MAX ? trimmed : null;
}

/** Trimmed, de-duplicated option list of a SELECT field, or null if invalid. */
export function normalizeOptions(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const options: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const option = raw.trim();
    if (option.length < 1 || option.length > OPTION_MAX_LENGTH) return null;
    if (options.includes(option)) return null;
    options.push(option);
  }
  return options.length >= 1 && options.length <= OPTIONS_MAX ? options : null;
}

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (year < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Whether `value` is a valid non-null value of the definition. */
export function isValidValue(
  def: Pick<FieldDef, 'type' | 'options'>,
  value: unknown,
): value is FieldValue {
  switch (def.type) {
    case 'TEXT':
      return typeof value === 'string' && value.length <= TEXT_VALUE_MAX;
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value);
    case 'DATE':
      return typeof value === 'string' && isCalendarDate(value);
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'SELECT':
      return typeof value === 'string' && (def.options ?? []).includes(value);
  }
}

export type ValuesPlan =
  | { ok: true; set: Record<string, FieldValue>; clear: string[] }
  | { ok: false; code: 'UNKNOWN_FIELD' | 'INVALID_VALUE'; key: string };

/**
 * Validates a `values` patch against the ACTIVE definitions: an unknown or
 * archived key is UNKNOWN_FIELD (checked for all keys first), a wrong value
 * INVALID_VALUE, `null` clears the key.
 */
export function planFieldValues(
  defs: readonly Pick<FieldDef, 'key' | 'type' | 'options'>[],
  values: Readonly<Record<string, unknown>>,
): ValuesPlan {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const keys = Object.keys(values);
  for (const key of keys) if (!byKey.has(key)) return unknownKey(key);
  const set: Record<string, FieldValue> = {};
  const clear: string[] = [];
  for (const key of keys) {
    const value = values[key];
    if (value === null) clear.push(key);
    else if (isValidValue(byKey.get(key)!, value)) set[key] = value;
    else return { ok: false, code: 'INVALID_VALUE', key };
  }
  return { ok: true, set, clear };
}

function unknownKey(key: string): ValuesPlan {
  return { ok: false, code: 'UNKNOWN_FIELD', key };
}

/** Stored values merged with a validated patch (new object). */
export function applyFieldValues(
  stored: Readonly<Record<string, unknown>>,
  plan: { set: Record<string, FieldValue>; clear: string[] },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored, ...plan.set };
  for (const key of plan.clear) delete next[key];
  return next;
}

/** Reads the stored jsonb as a plain object (anything else = no values). */
export function asValues(stored: unknown): Record<string, unknown> {
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

/** Active definitions with their values, in position order (null if unset). */
export function describeFields(
  defs: readonly FieldDef[],
  stored: unknown,
): Array<{ key: string; label: string; type: FieldType; value: FieldValue | null }> {
  const values = asValues(stored);
  return [...defs]
    .sort((a, b) => a.position - b.position)
    .map((d) => ({
      key: d.key,
      label: d.label,
      type: d.type,
      value: Object.hasOwn(values, d.key) && values[d.key] !== null
        ? (values[d.key] as FieldValue)
        : null,
    }));
}

/**
 * Converts a query-string value to the typed value of the definition for an
 * exact-match filter, or undefined when it does not fit the definition.
 */
export function parseFilterValue(
  def: Pick<FieldDef, 'type' | 'options'>,
  raw: string,
): FieldValue | undefined {
  let value: unknown = raw;
  if (def.type === 'BOOLEAN') {
    if (raw !== 'true' && raw !== 'false') return undefined;
    value = raw === 'true';
  } else if (def.type === 'NUMBER') {
    if (raw.trim() === '') return undefined;
    value = Number(raw);
  }
  return isValidValue(def, value) ? value : undefined;
}

/** Distinct ids in first-seen order. */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** True when a tag set would exceed the per-entity limit. */
export function exceedsTagLimit(count: number): boolean {
  return count > MAX_TAGS_PER_ENTITY;
}

export interface Carried {
  tagIds: string[];
  fields: Record<string, unknown>;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Merge (ADR 053): what the survivor takes from the merged person. Tags: the
 * union, capped at the per-entity limit (sorted by id, so deterministic).
 * Fields: only keys that are EMPTY on the survivor and set on the source.
 */
export function planMergeCarry(input: {
  survivorTagIds: readonly string[];
  sourceTagIds: readonly string[];
  survivorFields: Readonly<Record<string, unknown>>;
  sourceFields: Readonly<Record<string, unknown>>;
}): Carried {
  const have = new Set(input.survivorTagIds);
  const room = Math.max(0, MAX_TAGS_PER_ENTITY - have.size);
  const tagIds = uniqueIds(input.sourceTagIds)
    .filter((id) => !have.has(id))
    .sort()
    .slice(0, room);
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(input.sourceFields).sort()) {
    const value = input.sourceFields[key];
    if (!isEmpty(value) && isEmpty(input.survivorFields[key]))
      fields[key] = value;
  }
  return { tagIds, fields };
}

/**
 * Unmerge: removes exactly the carried tags still on the survivor and clears
 * exactly the carried fields whose value is still the carried one. A field
 * edited after the merge stays.
 */
export function planUnmergeCarry(input: {
  carried: Carried | null;
  survivorTagIds: readonly string[];
  survivorFields: Readonly<Record<string, unknown>>;
}): { removeTagIds: string[]; clearKeys: string[] } {
  if (!input.carried) return { removeTagIds: [], clearKeys: [] };
  const present = new Set(input.survivorTagIds);
  return {
    removeTagIds: input.carried.tagIds.filter((id) => present.has(id)),
    clearKeys: Object.keys(input.carried.fields).filter(
      (key) => input.survivorFields[key] === input.carried!.fields[key],
    ),
  };
}

/** Reads `person_merges.carried` defensively (null when absent or malformed). */
export function parseCarried(stored: unknown): Carried | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored))
    return null;
  const { tagIds, fields } = stored as Record<string, unknown>;
  if (!Array.isArray(tagIds) || !tagIds.every((t) => typeof t === 'string'))
    return null;
  return { tagIds: tagIds as string[], fields: asValues(fields) };
}
