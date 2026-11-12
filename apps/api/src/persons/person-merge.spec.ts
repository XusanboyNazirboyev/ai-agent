import { describe, expect, it } from 'vitest';
import {
  buildDuplicateGroups,
  canUnmerge,
  phoneKey,
  planMerge,
  type PersonState,
} from './person-merge.js';

const NOW = new Date('2026-11-12T00:00:00Z');
const person = (
  id: string,
  contacts: Array<[string, boolean]>,
  extra: Partial<PersonState> = {},
): PersonState => ({
  id,
  mergedIntoId: null,
  deletedAt: null,
  contacts: contacts.map(([cid, erased]) => ({
    id: cid,
    deletedAt: erased ? NOW : null,
  })),
  ...extra,
});

describe('phoneKey', () => {
  it('matches national and international Uzbek formats', () => {
    const keys = [
      '+998 90 123 45 67',
      '998901234567',
      '90 123 45 67',
      '(90) 123-45-67',
      '+998(90)1234567',
    ].map(phoneKey);
    expect(new Set(keys)).toEqual(new Set(['901234567']));
  });

  it('needs at least 9 digits and ignores empty values', () => {
    expect(phoneKey('12345678')).toBeNull();
    expect(phoneKey('+1 234')).toBeNull();
    expect(phoneKey('')).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey('abc')).toBeNull();
    expect(phoneKey('123456789')).toBe('123456789');
  });

  it('distinguishes numbers that differ in the last 9 digits', () => {
    expect(phoneKey('+998901234567')).not.toBe(phoneKey('+998901234568'));
  });
});

describe('planMerge', () => {
  it('moves every contact row of the source, erased ones included, sorted', () => {
    const plan = planMerge(
      person('s', [
        ['c2', false],
        ['c1', true],
      ]),
      person('t', [['c9', false]]),
    );
    expect(plan).toEqual({ ok: true, contactIds: ['c1', 'c2'] });
  });

  it('refuses the same person', () => {
    const p = person('a', [['c', false]]);
    expect(planMerge(p, p)).toEqual({ ok: false, code: 'SAME_PERSON' });
  });

  it.each([
    ['source merged', { mergedIntoId: 'x' }, {}],
    ['source deleted', { deletedAt: NOW }, {}],
    ['survivor merged', {}, { mergedIntoId: 'x' }],
    ['survivor deleted', {}, { deletedAt: NOW }],
  ])('refuses when %s', (_name, a, b) => {
    expect(
      planMerge(
        person('s', [['c1', false]], a),
        person('t', [['c2', false]], b),
      ),
    ).toEqual({ ok: false, code: 'MERGE_REFUSED' });
  });

  it('refuses a person without a non-erased contact', () => {
    expect(
      planMerge(person('s', [['c1', true]]), person('t', [['c2', false]])),
    ).toEqual({ ok: false, code: 'MERGE_REFUSED' });
    expect(planMerge(person('s', [['c1', false]]), person('t', []))).toEqual({
      ok: false,
      code: 'MERGE_REFUSED',
    });
  });
});

describe('canUnmerge', () => {
  const base = (): Parameters<typeof canUnmerge>[0] => ({
    survivor: {
      id: 'S',
      mergedIntoId: null as string | null,
      deletedAt: null as Date | null,
    },
    merge: { mergedId: 'M', contactIds: ['c1', 'c2'] },
    mergedPerson: { mergedIntoId: 'S' } as {
      mergedIntoId: string | null;
    } | null,
    contacts: [
      { id: 'c1', personId: 'S', deletedAt: null as Date | null },
      { id: 'c2', personId: 'S', deletedAt: null as Date | null },
    ],
  });

  it('allows the normal case', () => {
    expect(canUnmerge(base())).toBe(true);
  });

  it('is blocked when the survivor is merged or deleted', () => {
    const a = base();
    a.survivor.mergedIntoId = 'Z';
    expect(canUnmerge(a)).toBe(false);
    const b = base();
    b.survivor.deletedAt = NOW;
    expect(canUnmerge(b)).toBe(false);
  });

  it('is blocked when the merged person no longer points at the survivor', () => {
    const a = base();
    a.mergedPerson = { mergedIntoId: null };
    expect(canUnmerge(a)).toBe(false);
    const b = base();
    b.mergedPerson = null;
    expect(canUnmerge(b)).toBe(false);
  });

  it('is blocked when a snapshot contact is erased, missing or elsewhere', () => {
    const a = base();
    a.contacts[1].deletedAt = NOW;
    expect(canUnmerge(a)).toBe(false);
    const b = base();
    b.contacts.pop();
    expect(canUnmerge(b)).toBe(false);
    const c = base();
    c.contacts[0].personId = 'other';
    expect(canUnmerge(c)).toBe(false);
  });
});

describe('buildDuplicateGroups', () => {
  it('keeps only keys held by 2+ distinct persons, newest group first', () => {
    const groups = buildDuplicateGroups([
      { key: 'k1', personId: 'a' },
      { key: 'k1', personId: 'a' },
      { key: 'k2', personId: 'b' },
      { key: 'k2', personId: 'd' },
      { key: 'k3', personId: 'a' },
      { key: 'k3', personId: 'c' },
    ]);
    expect(groups).toEqual([
      ['d', 'b'],
      ['c', 'a'],
    ]);
  });

  it('caps each group at 10 newest persons and the list at 50 groups', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      key: 'big',
      personId: `p${String(i).padStart(2, '0')}`,
    }));
    const [group] = buildDuplicateGroups(many);
    expect(group).toHaveLength(10);
    expect(group[0]).toBe('p11');
    expect(group).not.toContain('p00');
    const lots = Array.from({ length: 60 }, (_, i) => [
      { key: `k${i}`, personId: `a${String(i).padStart(2, '0')}` },
      { key: `k${i}`, personId: `b${String(i).padStart(2, '0')}` },
    ]).flat();
    expect(buildDuplicateGroups(lots)).toHaveLength(50);
  });
});
