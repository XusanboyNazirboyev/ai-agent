import { describe, expect, it } from 'vitest';
import { filterBySubscription } from './subscription-filter';
import type { SubscriptionStatus } from './types';

const NOW = Date.parse('2026-11-17T09:00:00Z');
const row = (
  id: string,
  status: SubscriptionStatus | null,
  days = 0,
  churnedThisMonth = false,
): {
  id: string;
  churnedThisMonth: boolean;
  subscription: { status: SubscriptionStatus; currentPeriodEnd: string } | null;
} => ({
  id,
  churnedThisMonth,
  subscription: status
    ? {
        status,
        currentPeriodEnd: new Date(NOW + days * 86_400_000).toISOString(),
      }
    : null,
});

const rows = [
  row('trial-later', 'TRIAL', 20),
  row('active-soon', 'ACTIVE', 6),
  row('past-due', 'PAST_DUE', -1),
  row('expired-soon-date', 'EXPIRED', 2),
  row('none', null),
  row('trial-soon', 'TRIAL', 1),
];
const ids = (list: { id: string }[]): string[] => list.map((r) => r.id);

describe('filterBySubscription', () => {
  it('keeps the API order without a filter', () => {
    expect(ids(filterBySubscription(rows, '', NOW))).toEqual(ids(rows));
  });

  it('"ends soon" is an open subscription ending within 7 days, soonest first', () => {
    expect(ids(filterBySubscription(rows, 'ENDS_SOON', NOW))).toEqual([
      'past-due',
      'trial-soon',
      'active-soon',
    ]);
  });

  it('filters by status and by "no subscription"', () => {
    expect(ids(filterBySubscription(rows, 'TRIAL', NOW))).toEqual([
      'trial-soon',
      'trial-later',
    ]);
    expect(ids(filterBySubscription(rows, 'NONE', NOW))).toEqual(['none']);
    expect(ids(filterBySubscription(rows, 'EXPIRED', NOW))).toEqual([
      'expired-soon-date',
    ]);
  });

  it('matches the two overview-only business segments', () => {
    const special = [
      ...rows,
      row('trial-three-days', 'TRIAL', 3),
      row('trial-expired', 'TRIAL', -1),
      row('churned-this-month', 'EXPIRED', -5, true),
    ];
    expect(
      ids(filterBySubscription(special, 'TRIAL_ENDING_SOON', NOW)),
    ).toEqual(['trial-soon', 'trial-three-days']);
    expect(
      ids(filterBySubscription(special, 'CHURNED_THIS_MONTH', NOW)),
    ).toEqual(['churned-this-month']);
  });
});
