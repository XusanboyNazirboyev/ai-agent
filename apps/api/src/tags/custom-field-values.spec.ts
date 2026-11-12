import { describe, expect, it } from 'vitest';
import {
  MAX_TAGS_PER_ENTITY,
  applyFieldValues,
  describeFields,
  exceedsTagLimit,
  isCalendarDate,
  isValidFieldKey,
  isValidValue,
  normalizeOptions,
  normalizeTagName,
  parseCarried,
  parseFilterValue,
  planFieldValues,
  planMergeCarry,
  planUnmergeCarry,
  uniqueIds,
  type FieldDef,
} from './custom-field-values.js';

const def = (
  key: string,
  type: FieldDef['type'],
  options: string[] | null = null,
  position = 0,
): FieldDef => ({ key, label: key, type, options, position });

describe('field key slug', () => {
  it('accepts lowercase slugs up to 40 characters', () => {
    expect(isValidFieldKey('a')).toBe(true);
    expect(isValidFieldKey('budget_usd2')).toBe(true);
    expect(isValidFieldKey('a'.repeat(40))).toBe(true);
  });
  it('rejects uppercase, leading digit or underscore, dashes, 41 chars, empty', () => {
    for (const bad of ['Abc', '1abc', '_abc', 'a-b', 'a b', '', 'a'.repeat(41)])
      expect(isValidFieldKey(bad)).toBe(false);
  });
});

describe('tag name', () => {
  it('trims and enforces 1..40 characters', () => {
    expect(normalizeTagName('  VIP  ')).toBe('VIP');
    expect(normalizeTagName('x'.repeat(40))).toBe('x'.repeat(40));
    expect(normalizeTagName('x'.repeat(41))).toBeNull();
    expect(normalizeTagName('   ')).toBeNull();
  });
});

describe('SELECT options', () => {
  it('accepts 1..50 unique trimmed strings of 1..60 chars', () => {
    expect(normalizeOptions([' a ', 'b'])).toEqual(['a', 'b']);
    expect(normalizeOptions(['x'.repeat(60)])).toHaveLength(1);
    expect(
      normalizeOptions(Array.from({ length: 50 }, (_, i) => `o${i}`)),
    ).toHaveLength(50);
  });
  it('rejects empty, duplicate, long, non-string and over-50 lists', () => {
    expect(normalizeOptions([])).toBeNull();
    expect(normalizeOptions(['a', ' a '])).toBeNull();
    expect(normalizeOptions(['x'.repeat(61)])).toBeNull();
    expect(normalizeOptions(['  '])).toBeNull();
    expect(normalizeOptions([1])).toBeNull();
    expect(normalizeOptions('a')).toBeNull();
    expect(
      normalizeOptions(Array.from({ length: 51 }, (_, i) => `o${i}`)),
    ).toBeNull();
  });
});

describe('calendar date', () => {
  it('accepts real dates including a leap day', () => {
    expect(isCalendarDate('2026-11-12')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
  });
  it('rejects impossible and badly formatted dates', () => {
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-1-1',
      '26-11-12',
      '2026-11-12T00:00',
      '0000-01-01',
    ])
      expect(isCalendarDate(bad)).toBe(false);
  });
});

describe('value validation per type', () => {
  it('TEXT: string up to 500 characters', () => {
    const d = def('t', 'TEXT');
    expect(isValidValue(d, 'x'.repeat(500))).toBe(true);
    expect(isValidValue(d, 'x'.repeat(501))).toBe(false);
    expect(isValidValue(d, 5)).toBe(false);
  });
  it('NUMBER: finite numbers only', () => {
    const d = def('n', 'NUMBER');
    expect(isValidValue(d, 0)).toBe(true);
    expect(isValidValue(d, -1.5)).toBe(true);
    expect(isValidValue(d, Number.NaN)).toBe(false);
    expect(isValidValue(d, Infinity)).toBe(false);
    expect(isValidValue(d, '5')).toBe(false);
  });
  it('DATE: real YYYY-MM-DD only', () => {
    const d = def('d', 'DATE');
    expect(isValidValue(d, '2026-11-12')).toBe(true);
    expect(isValidValue(d, '2026-02-30')).toBe(false);
    expect(isValidValue(d, 20261112)).toBe(false);
  });
  it('BOOLEAN: booleans only', () => {
    const d = def('b', 'BOOLEAN');
    expect(isValidValue(d, false)).toBe(true);
    expect(isValidValue(d, 'true')).toBe(false);
    expect(isValidValue(d, 1)).toBe(false);
  });
  it('SELECT: one of the options', () => {
    const d = def('s', 'SELECT', ['a', 'b']);
    expect(isValidValue(d, 'a')).toBe(true);
    expect(isValidValue(d, 'c')).toBe(false);
    expect(isValidValue(d, 1)).toBe(false);
  });
});

describe('planFieldValues', () => {
  const defs = [def('note', 'TEXT'), def('size', 'NUMBER')];
  it('splits values into set and clear (null clears)', () => {
    expect(planFieldValues(defs, { note: 'hi', size: null })).toEqual({
      ok: true,
      set: { note: 'hi' },
      clear: ['size'],
    });
  });
  it('unknown key wins over a bad value elsewhere', () => {
    expect(planFieldValues(defs, { size: 'x', nope: 1 })).toEqual({
      ok: false,
      code: 'UNKNOWN_FIELD',
      key: 'nope',
    });
  });
  it('wrong type is INVALID_VALUE', () => {
    expect(planFieldValues(defs, { size: 'x' })).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      key: 'size',
    });
  });
  it('treats inherited names as unknown', () => {
    const plan = planFieldValues(defs, { constructor: 'x' });
    expect(plan.ok).toBe(false);
  });
});

describe('applyFieldValues and describeFields', () => {
  it('merges given keys, keeps others, removes cleared ones', () => {
    expect(
      applyFieldValues({ a: 1, b: 2, c: 3 }, { set: { a: 9 }, clear: ['b'] }),
    ).toEqual({ a: 9, c: 3 });
  });
  it('describes active definitions in position order with null when unset', () => {
    const defs = [def('b', 'TEXT', null, 2), def('a', 'NUMBER', null, 1)];
    expect(describeFields(defs, { b: 'x', gone: 'hidden' })).toEqual([
      { key: 'a', label: 'a', type: 'NUMBER', value: null },
      { key: 'b', label: 'b', type: 'TEXT', value: 'x' },
    ]);
  });
  it('survives a malformed stored value', () => {
    expect(describeFields([def('a', 'TEXT')], 'junk')[0].value).toBeNull();
  });
});

describe('parseFilterValue', () => {
  it('types the raw query value by the definition', () => {
    expect(parseFilterValue(def('b', 'BOOLEAN'), 'true')).toBe(true);
    expect(parseFilterValue(def('b', 'BOOLEAN'), 'yes')).toBeUndefined();
    expect(parseFilterValue(def('n', 'NUMBER'), '12.5')).toBe(12.5);
    expect(parseFilterValue(def('n', 'NUMBER'), 'abc')).toBeUndefined();
    expect(parseFilterValue(def('n', 'NUMBER'), ' ')).toBeUndefined();
    expect(parseFilterValue(def('s', 'SELECT', ['a']), 'a')).toBe('a');
    expect(parseFilterValue(def('s', 'SELECT', ['a']), 'z')).toBeUndefined();
  });
});

describe('tag limit', () => {
  it('allows up to 20 and refuses 21', () => {
    expect(exceedsTagLimit(MAX_TAGS_PER_ENTITY)).toBe(false);
    expect(exceedsTagLimit(MAX_TAGS_PER_ENTITY + 1)).toBe(true);
  });
  it('de-duplicates ids in first-seen order', () => {
    expect(uniqueIds(['b', 'a', 'b'])).toEqual(['b', 'a']);
  });
});

describe('planMergeCarry', () => {
  it('carries missing tags, sorted, and only fills empty fields', () => {
    expect(
      planMergeCarry({
        survivorTagIds: ['t1'],
        sourceTagIds: ['t3', 't1', 't2'],
        survivorFields: { a: 'mine', b: null },
        sourceFields: { a: 'theirs', b: 'x', c: 5, d: null },
      }),
    ).toEqual({ tagIds: ['t2', 't3'], fields: { b: 'x', c: 5 } });
  });
  it('caps the survivor at 20 tags', () => {
    const survivor = Array.from({ length: 19 }, (_, i) => `s${i}`);
    const carried = planMergeCarry({
      survivorTagIds: survivor,
      sourceTagIds: ['x1', 'x2', 'x3'],
      survivorFields: {},
      sourceFields: {},
    });
    expect(carried.tagIds).toEqual(['x1']);
  });
  it('carries nothing when the survivor is already full', () => {
    const survivor = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(
      planMergeCarry({
        survivorTagIds: survivor,
        sourceTagIds: ['x'],
        survivorFields: {},
        sourceFields: {},
      }).tagIds,
    ).toEqual([]);
  });
});

describe('planUnmergeCarry', () => {
  const carried = { tagIds: ['t1', 't2'], fields: { a: 'x', b: 'y' } };
  it('removes the carried tags and unchanged fields', () => {
    expect(
      planUnmergeCarry({
        carried,
        survivorTagIds: ['t1', 't2', 'own'],
        survivorFields: { a: 'x', b: 'y', own: 1 },
      }),
    ).toEqual({ removeTagIds: ['t1', 't2'], clearKeys: ['a', 'b'] });
  });
  it('keeps a field edited after the merge and ignores tags already gone', () => {
    expect(
      planUnmergeCarry({
        carried,
        survivorTagIds: ['t2'],
        survivorFields: { a: 'edited', b: 'y' },
      }),
    ).toEqual({ removeTagIds: ['t2'], clearKeys: ['b'] });
  });
  it('does nothing for a merge without a carried record', () => {
    expect(
      planUnmergeCarry({
        carried: null,
        survivorTagIds: ['t1'],
        survivorFields: { a: 1 },
      }),
    ).toEqual({ removeTagIds: [], clearKeys: [] });
  });
  it('parses the stored record defensively', () => {
    expect(parseCarried({ tagIds: ['a'], fields: { k: 1 } })).toEqual({
      tagIds: ['a'],
      fields: { k: 1 },
    });
    expect(parseCarried(null)).toBeNull();
    expect(parseCarried({ tagIds: [1], fields: {} })).toBeNull();
    expect(parseCarried([])).toBeNull();
  });
});
