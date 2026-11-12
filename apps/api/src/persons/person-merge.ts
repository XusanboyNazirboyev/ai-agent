/**
 * Pure rules of person duplicates, merge and unmerge (ADR 052 slices C-D).
 * No database access: the services load plain rows and ask these functions.
 */

/** Length of the phone key: the last 9 digits (Uzbek national number). */
export const PHONE_KEY_LENGTH = 9;

/**
 * Duplicate-detection key of a stored contact phone: the last 9 digits of its
 * digits, or null when the phone has fewer than 9 digits. Stored phones were
 * typed by the customer (VOICE_DIGITS_POLICY keeps heard digits out). The same
 * expression is used in SQL (`PHONE_KEY_SQL`); keep both in step.
 */
export function phoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= PHONE_KEY_LENGTH
    ? digits.slice(-PHONE_KEY_LENGTH)
    : null;
}

/** SQL twin of `phoneKey` for a column expression (NULL when under 9 digits). */
export const PHONE_KEY_SQL = (column: string): string =>
  `CASE WHEN length(regexp_replace(${column}, '\\D', '', 'g')) >= ${PHONE_KEY_LENGTH} ` +
  `THEN right(regexp_replace(${column}, '\\D', '', 'g'), ${PHONE_KEY_LENGTH}) END`;

export interface PersonState {
  id: string;
  mergedIntoId: string | null;
  deletedAt: Date | null;
  /** Every contact row of the person, erased ones included. */
  contacts: Array<{ id: string; deletedAt: Date | null }>;
}

export type MergePlan =
  | { ok: true; contactIds: string[] }
  | { ok: false; code: 'SAME_PERSON' | 'MERGE_REFUSED' };

function mergeable(p: PersonState): boolean {
  return (
    p.mergedIntoId === null &&
    p.deletedAt === null &&
    p.contacts.some((c) => c.deletedAt === null)
  );
}

/**
 * Plans merging `source` into `survivor`: refused when it is the same person
 * or either one is merged, deleted, or has no non-erased contact. The moved
 * contacts are every contact row of the source (erased ones too), sorted.
 */
export function planMerge(
  source: PersonState,
  survivor: PersonState,
): MergePlan {
  if (source.id === survivor.id) return { ok: false, code: 'SAME_PERSON' };
  if (!mergeable(source) || !mergeable(survivor))
    return { ok: false, code: 'MERGE_REFUSED' };
  return { ok: true, contactIds: source.contacts.map((c) => c.id).sort() };
}

export interface UnmergeInput {
  survivor: { id: string; mergedIntoId: string | null; deletedAt: Date | null };
  merge: { mergedId: string; contactIds: string[] };
  mergedPerson: { mergedIntoId: string | null } | null;
  /** Current state of the snapshot contacts that still exist. */
  contacts: Array<{
    id: string;
    personId: string | null;
    deletedAt: Date | null;
  }>;
}

/**
 * An unmerge is blocked when the survivor is itself merged or deleted, when
 * the merged person no longer points at the survivor, or when any snapshot
 * contact is erased, missing or no longer on the survivor (never guess).
 */
export function canUnmerge(input: UnmergeInput): boolean {
  const { survivor, merge, mergedPerson, contacts } = input;
  if (survivor.mergedIntoId !== null || survivor.deletedAt !== null)
    return false;
  if (!mergedPerson || mergedPerson.mergedIntoId !== survivor.id) return false;
  if (contacts.length !== merge.contactIds.length) return false;
  return contacts.every(
    (c) =>
      merge.contactIds.includes(c.id) &&
      c.deletedAt === null &&
      c.personId === survivor.id,
  );
}

/**
 * Groups of persons sharing a phone key: only keys held by 2 or more distinct
 * persons, each group capped at `groupCap` newest persons (ids are time-ordered
 * uuid v7), groups ordered by their newest person, at most `maxGroups`.
 */
export function buildDuplicateGroups(
  rows: Array<{ key: string; personId: string }>,
  maxGroups = 50,
  groupCap = 10,
): string[][] {
  const byKey = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byKey.get(r.key) ?? new Set<string>();
    set.add(r.personId);
    byKey.set(r.key, set);
  }
  return [...byKey.values()]
    .filter((s) => s.size >= 2)
    .map((s) => [...s].sort().reverse().slice(0, groupCap))
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .slice(0, maxGroups);
}
