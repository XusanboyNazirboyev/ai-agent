import { describe, expect, it } from 'vitest';
import {
  localMonth,
  monthStartInZone,
  reachedThreshold,
} from './lead-limit.js';
import { planLimitsOf } from './plan-limits.js';

describe('reachedThreshold', () => {
  it('is 0 below 80 %, 80 from 80 %, 100 from the limit', () => {
    expect(reachedThreshold(0, 500)).toBe(0);
    expect(reachedThreshold(399, 500)).toBe(0);
    expect(reachedThreshold(400, 500)).toBe(80);
    expect(reachedThreshold(499, 500)).toBe(80);
    expect(reachedThreshold(500, 500)).toBe(100);
    expect(reachedThreshold(900, 500)).toBe(100);
  });
  it('handles small limits and bad input without fractions', () => {
    expect(reachedThreshold(4, 5)).toBe(80);
    expect(reachedThreshold(3, 4)).toBe(0);
    expect(reachedThreshold(1, 1)).toBe(100);
    expect(reachedThreshold(5, 0)).toBe(0);
    expect(reachedThreshold(5, 1.5)).toBe(0);
  });
});

describe('month in the tenant time zone', () => {
  it('starts the month at local midnight', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    expect(monthStartInZone(now, 'UTC').toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    // Tashkent is UTC+5 all year.
    expect(monthStartInZone(now, 'Asia/Tashkent').toISOString()).toBe(
      '2026-10-31T19:00:00.000Z',
    );
  });
  it('follows the local calendar at the month edge', () => {
    // 20:00 UTC on 31 Oct is already 1 Nov in Tashkent.
    const edge = new Date('2026-10-31T20:00:00Z');
    expect(localMonth(edge, 'UTC')).toBe('2026-10');
    expect(localMonth(edge, 'Asia/Tashkent')).toBe('2026-11');
    expect(monthStartInZone(edge, 'Asia/Tashkent').toISOString()).toBe(
      '2026-10-31T19:00:00.000Z',
    );
  });
  it('handles a daylight saving zone', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    // New York is UTC-4 after 8 March, but 1 March was still UTC-5.
    expect(monthStartInZone(now, 'America/New_York').toISOString()).toBe(
      '2026-03-01T05:00:00.000Z',
    );
  });
});

describe('monthlyNewLeads limit', () => {
  it('accepts a positive integer only', () => {
    expect(planLimitsOf({ monthlyNewLeads: 500 })).toEqual({
      monthlyNewLeads: 500,
    });
    expect(planLimitsOf({ monthlyNewLeads: 0 })).toEqual({});
    expect(planLimitsOf({ monthlyNewLeads: 2.5 })).toEqual({});
    expect(planLimitsOf({ monthlyNewLeads: '5' })).toEqual({});
  });
});
