/**
 * A short time for a list row, like a messenger: the clock time today, the
 * weekday within the last week, otherwise the day and month. Pure: the zone
 * and the clock are passed in.
 */
export function shortTime(
  iso: string,
  now: number,
  locale: string,
  timeZone?: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const zone = timeZone ? { timeZone } : {};
  const tag = locale === 'uz-Latn' ? 'uz-Latn' : locale;
  try {
    const day = (value: Date | number): string =>
      new Intl.DateTimeFormat('en-CA', zone).format(value);
    if (day(date) === day(now))
      return new Intl.DateTimeFormat(tag, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        ...zone,
      }).format(date);
    const days = (now - date.getTime()) / 86_400_000;
    if (days < 6)
      return new Intl.DateTimeFormat(tag, { weekday: 'short', ...zone }).format(
        date,
      );
    return new Intl.DateTimeFormat(tag, {
      day: 'numeric',
      month: 'short',
      ...zone,
    }).format(date);
  } catch {
    return '';
  }
}

/** Whether an instant falls on the same calendar day as `now` in the zone. */
export function isSameDay(
  iso: string,
  now: number,
  timeZone?: string,
): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  try {
    const day = (value: Date | number): string =>
      new Intl.DateTimeFormat('en-CA', timeZone ? { timeZone } : {}).format(
        value,
      );
    return day(date) === day(now);
  } catch {
    return false;
  }
}
