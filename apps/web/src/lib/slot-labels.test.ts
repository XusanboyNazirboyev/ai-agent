import { describe, expect, it } from 'vitest';
import { translate } from '@/i18n';
import { humanize, slotPairs } from './slot-labels';

describe('slotPairs', () => {
  const label = (key: string): string => translate('uz-Latn', key);
  it('labels known slots in the language and spells out unknown ones', () => {
    expect(
      slotPairs(
        { destination: 'Dubai', travelMonth: 'june', petName: 'Rex' },
        label,
      ),
    ).toEqual([
      { label: 'Yo‘nalish', value: 'Dubai' },
      { label: 'Sayohat oyi', value: 'june' },
      { label: 'Pet name', value: 'Rex' },
    ]);
  });
  it('never shows a raw key and skips what has no value', () => {
    expect(slotPairs(null, label)).toEqual([]);
    expect(slotPairs({ nested: { deep: { deeper: 1 } } }, label)).toEqual([]);
  });
  it('humanizes names', () => {
    expect(humanize('partySize')).toBe('Party size');
    expect(humanize('student_age')).toBe('Student age');
  });
});
