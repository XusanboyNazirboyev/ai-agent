import { describe, expect, it } from 'vitest';
import {
  durationParts,
  formatPercent,
  formatUsd,
  shiftDay,
  todayIn,
} from './analytics-format';

describe('analytics formatting', () => {
  it('shows a missing rate as a dash, never as 0%', () => {
    expect(formatPercent('en', null)).toBe('—');
    expect(formatPercent('en', 0)).toBe('0%');
    expect(formatPercent('en', 0.2)).toBe('20%');
    expect(formatPercent('en', 0.034)).toBe('3.4%');
  });

  it('reads durations in the unit that fits', () => {
    expect(durationParts('en', null)).toBeNull();
    expect(durationParts('en', 4)).toEqual({ unit: 's', value: '4' });
    expect(durationParts('en', 4.25)).toEqual({ unit: 's', value: '4.3' });
    expect(durationParts('en', 86.5)).toEqual({ unit: 's', value: '87' });
    expect(durationParts('en', 600)).toEqual({ unit: 'min', value: '10' });
    expect(durationParts('en', 7_200)).toEqual({ unit: 'h', value: '2' });
  });

  it('keeps tiny costs visible', () => {
    expect(formatUsd('en', null)).toBe('—');
    expect(formatUsd('en', 0)).toBe('$0.00');
    expect(formatUsd('en', 0.0008)).toBe('$0.0008');
    expect(formatUsd('en', 0.25)).toBe('$0.250');
    expect(formatUsd('en', 12.5)).toBe('$12.50');
  });

  it('does day arithmetic by the calendar and finds the day in a time zone', () => {
    expect(shiftDay('2026-03-01', 29)).toBe('2026-01-31');
    expect(shiftDay('2026-03-01', 1)).toBe('2026-02-28');
    const instant = new Date('2026-03-03T22:00:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-03-03');
    expect(todayIn('Asia/Tashkent', instant)).toBe('2026-03-04');
  });
});
