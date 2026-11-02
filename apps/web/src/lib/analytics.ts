import type { Locale } from '@/i18n';

/** The preset lengths of the Analytics date range, in days. */
export const RANGE_PRESETS = [7, 30, 90] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** A calendar day (YYYY-MM-DD) moved by whole days; no time zone involved. */
export function shiftDay(day: string, days: number): string {
  if (!DAY.test(day)) throw new Error('Invalid day');
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The last `days` calendar days ending on `to` (inclusive). */
export function presetRange(
  to: string,
  days: number,
): { from: string; to: string } {
  return { from: shiftDay(to, -(days - 1)), to };
}

export interface MetricFormat {
  count: (value: number) => string;
  /** A 0..1 ratio as a percentage; `null` means "no data". */
  percent: (value: number | null) => string;
  /** Seconds as s / min / h, whichever reads best. */
  duration: (seconds: number | null) => string;
  milliseconds: (value: number | null) => string;
  usd: (value: number | null) => string;
  /** A calendar day (YYYY-MM-DD) as a short date. */
  day: (value: string) => string;
}

/** Shown for a metric without data (nothing to divide by); not a word. */
export const NO_DATA = '—';

/** The UI locales are BCP 47 tags, so Intl takes them as they are. */
export function metricFormat(l: Locale): MetricFormat {
  const count = new Intl.NumberFormat(l);
  const percent = new Intl.NumberFormat(l, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const unit = (name: string, digits: number): Intl.NumberFormat =>
    new Intl.NumberFormat(l, {
      style: 'unit',
      unit: name,
      unitDisplay: 'short',
      maximumFractionDigits: digits,
    });
  const seconds = unit('second', 0);
  const minutes = unit('minute', 1);
  const hours = unit('hour', 1);
  const ms = unit('millisecond', 0);
  const usd = new Intl.NumberFormat(l, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  });
  const day = new Intl.DateTimeFormat(l, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return {
    count: (value) => count.format(value),
    percent: (value) => (value === null ? NO_DATA : percent.format(value)),
    duration: (value): string => {
      if (value === null) return NO_DATA;
      if (value < 60) return seconds.format(value);
      if (value < 3600) return minutes.format(value / 60);
      return hours.format(value / 3600);
    },
    milliseconds: (value) => (value === null ? NO_DATA : ms.format(value)),
    usd: (value) => (value === null ? NO_DATA : usd.format(value)),
    day: (value) => day.format(new Date(`${value}T00:00:00Z`)),
  };
}
