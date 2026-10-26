import type { Locale } from '@/i18n';

/** Intl needs a BCP 47 tag; the UI locale id "uz-Latn" is one already. */
const tag = (locale: Locale): string => locale;

export function formatCount(locale: Locale, value: number): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

/** 0.2 -> "20%". A missing rate (nothing to divide by) is an em dash, never 0%. */
export function formatPercent(locale: Locale, rate: number | null): string {
  if (rate === null) return '—';
  return new Intl.NumberFormat(tag(locale), {
    style: 'percent',
    maximumFractionDigits: rate < 0.1 && rate > 0 ? 1 : 0,
  }).format(rate);
}

export interface DurationParts {
  unit: 's' | 'min' | 'h';
  value: string;
}

/** Seconds as a short reading: "4 s", "1.4 min", "2.5 h"; null stays null. */
export function durationParts(
  locale: Locale,
  seconds: number | null,
): DurationParts | null {
  if (seconds === null) return null;
  const number = (value: number, digits: number): string =>
    new Intl.NumberFormat(tag(locale), {
      maximumFractionDigits: digits,
    }).format(value);
  if (seconds < 90)
    return { unit: 's', value: number(seconds, seconds < 10 ? 1 : 0) };
  if (seconds < 5_400) return { unit: 'min', value: number(seconds / 60, 1) };
  return { unit: 'h', value: number(seconds / 3_600, 1) };
}

/** Milliseconds of model latency as seconds. */
export function millisToSeconds(ms: number | null): number | null {
  return ms === null ? null : ms / 1000;
}

/** USD with enough digits for a fraction of a cent. */
export function formatUsd(locale: Locale, value: number | null): string {
  if (value === null) return '—';
  const digits = value === 0 ? 2 : value < 0.01 ? 4 : value < 1 ? 3 : 2;
  return new Intl.NumberFormat(tag(locale), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Today's calendar day in a time zone, as YYYY-MM-DD. */
export function todayIn(
  timeZone: string | undefined,
  now = new Date(),
): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The day `days` before `day` (YYYY-MM-DD), by calendar arithmetic. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** "2026-03-01" for a chart axis in the UI locale ("Mar 1", "1 мар."). */
export function formatDay(locale: Locale, day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(tag(locale), {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
