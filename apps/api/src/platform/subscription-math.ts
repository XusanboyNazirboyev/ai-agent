const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * New period end when a subscription is extended by `days`: counted from the
 * current end (grace is not free), but never ending in the past, so a long
 * overdue tenant gets the full `days` from now.
 */
export function extendedPeriodEnd(
  currentEnd: Date,
  days: number,
  now: Date,
): Date {
  const fromEnd = addDays(currentEnd, days);
  return fromEnd > now ? fromEnd : addDays(now, days);
}

/** First day of the UTC month of `now`: the window of "this month" usage. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Nano-USD (llm_usage_records.cost_nano_usd) to USD for display. */
export function nanoToUsd(nano: bigint | null | undefined): number {
  if (!nano) return 0;
  return Number(nano) / 1e9;
}
