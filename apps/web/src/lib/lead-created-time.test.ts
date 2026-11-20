import { describe, expect, it } from 'vitest';
import { leadCreatedTime } from './lead-created-time';

const NOW = Date.parse('2026-11-19T19:17:00Z'); // Nov 20, 00:17 in Tashkent

describe('lead creation time', () => {
  it('matches the reference: yesterday at 10:17, fourteen hours ago in the tenant zone', () => {
    expect(
      leadCreatedTime('2026-11-19T05:17:00Z', NOW, 'uz-Latn', 'Asia/Tashkent'),
    ).toMatchObject({
      day: 'yesterday',
      time: '10:17',
      elapsed: 'hours',
      count: 14,
    });
    expect(leadCreatedTime('2026-11-19T05:17:00Z', NOW, 'en', 'UTC')?.day).toBe(
      'today',
    );
  });

  it.each(['en', 'ru', 'uz-Latn'])(
    'uses a 24-hour clock and localized older dates for %s',
    (locale) => {
      const value = leadCreatedTime(
        '2025-01-04T05:17:00Z',
        NOW,
        locale,
        'Asia/Tashkent',
      );
      expect(value).toMatchObject({
        day: 'date',
        time: '10:17',
        elapsed: 'days',
      });
      expect(value?.date).toContain('2025');
      expect(value?.date).not.toContain('Invalid');
    },
  );

  it('compares calendar days, not 24-hour durations, across a daylight-saving change', () => {
    // New York's Nov 1 2026 has 25 hours: 00:30 EDT to 23:30 EST is still today.
    const value = leadCreatedTime(
      '2026-11-01T04:30:00Z',
      Date.parse('2026-11-02T04:30:00Z'),
      'en',
      'America/New_York',
    );
    expect(value).toMatchObject({
      day: 'today',
      time: '00:30',
      elapsed: 'days',
      count: 1,
    });
  });

  it.each([
    [0, 'now', 0],
    [59_000, 'now', 0],
    [60_000, 'minutes', 1],
    [59 * 60_000, 'minutes', 59],
    [60 * 60_000, 'hours', 1],
    [24 * 60 * 60_000, 'days', 1],
  ])('formats elapsed %s ms as %s/%s', (age, elapsed, count) => {
    expect(
      leadCreatedTime(new Date(NOW - age).toISOString(), NOW, 'en'),
    ).toMatchObject({ elapsed, count });
  });

  it('clamps future clock skew and rejects malformed timestamps', () => {
    expect(
      leadCreatedTime(new Date(NOW + 60_000).toISOString(), NOW, 'en'),
    ).toMatchObject({ elapsed: 'now', count: 0 });
    expect(leadCreatedTime('invalid', NOW, 'en')).toBeNull();
    expect(leadCreatedTime(new Date(NOW).toISOString(), NaN, 'en')).toBeNull();
  });
});
