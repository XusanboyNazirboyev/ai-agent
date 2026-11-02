import { describe, expect, it } from 'vitest';
import { metricFormat, NO_DATA, presetRange, shiftDay } from './analytics';

describe('analytics date range', () => {
  it('moves calendar days across month and leap-year ends', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('a preset covers exactly that many days, ending on the given day', () => {
    expect(presetRange('2026-11-02', 7)).toEqual({
      from: '2026-10-27',
      to: '2026-11-02',
    });
    expect(presetRange('2026-11-02', 1)).toEqual({
      from: '2026-11-02',
      to: '2026-11-02',
    });
  });

  it('refuses a value that is not a calendar day', () => {
    expect(() => shiftDay('02.11.2026', 1)).toThrow();
  });
});

describe('analytics number formats', () => {
  const f = metricFormat('en');

  it('shows a dash, not zero, when there is nothing to measure', () => {
    expect(f.percent(null)).toBe(NO_DATA);
    expect(f.duration(null)).toBe(NO_DATA);
    expect(f.milliseconds(null)).toBe(NO_DATA);
    expect(f.usd(null)).toBe(NO_DATA);
  });

  it('formats ratios, durations and money', () => {
    expect(f.percent(0.125)).toBe('12.5%');
    expect(f.percent(0)).toBe('0%');
    expect(f.duration(42)).toBe('42 sec');
    expect(f.duration(90)).toBe('1.5 min');
    expect(f.duration(7200)).toBe('2 hr');
    expect(f.usd(0.0123)).toBe('$0.0123');
    expect(f.count(12345)).toBe('12,345');
    expect(f.day('2026-11-02')).toBe('Nov 2');
  });

  it('formats in every UI locale without throwing', () => {
    for (const locale of ['uz-Latn', 'ru', 'en'] as const) {
      const g = metricFormat(locale);
      expect(g.percent(0.5)).toMatch(/50/u);
      expect(g.day('2026-01-15')).toMatch(/15/u);
    }
  });
});
