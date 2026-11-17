import type { SubscriptionStatus } from './types';

/** "Ends soon" in the console list: an open subscription within this many days. */
export const ENDS_SOON_DAYS = 7;

export const SUBSCRIPTION_FILTERS = [
  'ENDS_SOON',
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'EXPIRED',
  'CANCELED',
  'NONE',
] as const;

export type SubscriptionFilter = (typeof SUBSCRIPTION_FILTERS)[number];

interface Row {
  subscription: {
    status: SubscriptionStatus;
    currentPeriodEnd: string;
  } | null;
}

const OPEN: readonly SubscriptionStatus[] = ['TRIAL', 'ACTIVE', 'PAST_DUE'];

function matches(row: Row, filter: SubscriptionFilter, now: number): boolean {
  const sub = row.subscription;
  if (filter === 'NONE') return sub === null;
  if (!sub) return false;
  if (filter !== 'ENDS_SOON') return sub.status === filter;
  return (
    OPEN.includes(sub.status) &&
    Date.parse(sub.currentPeriodEnd) - now <= ENDS_SOON_DAYS * 86_400_000
  );
}

/**
 * The console customer list by subscription: with a filter, only matching
 * rows, the soonest period end first (rows without one last); without a
 * filter the rows unchanged (newest customer first, as the API sends them).
 */
export function filterBySubscription<T extends Row>(
  rows: readonly T[],
  filter: SubscriptionFilter | '',
  now: number,
): T[] {
  if (filter === '') return [...rows];
  const end = (row: T): number =>
    row.subscription
      ? Date.parse(row.subscription.currentPeriodEnd)
      : Number.POSITIVE_INFINITY;
  return rows
    .filter((row) => matches(row, filter, now))
    .sort((a, b) => end(a) - end(b));
}
