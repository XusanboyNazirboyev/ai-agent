import { describe, expect, it } from 'vitest';
import { isSameDay, shortTime } from './inbox-row';

const NOW = Date.parse('2026-11-14T10:00:00Z'); // 15:00 in Tashkent

describe('shortTime', () => {
  it('shows the clock for today in the workspace zone', () => {
    expect(shortTime('2026-11-14T08:05:00Z', NOW, 'en', 'Asia/Tashkent')).toBe(
      '13:05',
    );
    // Just after midnight in Tashkent is still "today" there, "yesterday" in UTC.
    expect(shortTime('2026-11-13T19:30:00Z', NOW, 'en', 'Asia/Tashkent')).toBe(
      '00:30',
    );
  });
  it('shows the weekday within the last week and the date after that', () => {
    expect(shortTime('2026-11-12T08:00:00Z', NOW, 'en', 'UTC')).toBe('Thu');
    expect(shortTime('2026-10-20T08:00:00Z', NOW, 'en', 'UTC')).toBe('Oct 20');
  });
  it('survives a bad value', () => {
    expect(shortTime('nope', NOW, 'en')).toBe('');
  });
});

describe('isSameDay', () => {
  it('compares calendar days in the workspace zone', () => {
    expect(isSameDay('2026-11-14T08:00:00Z', NOW, 'Asia/Tashkent')).toBe(true);
    expect(isSameDay('2026-11-13T23:00:00Z', NOW, 'UTC')).toBe(false);
    expect(isSameDay('2026-11-13T23:00:00Z', NOW, 'Asia/Tashkent')).toBe(true);
    expect(isSameDay('nope', NOW)).toBe(false);
  });
});
