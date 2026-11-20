/** Creation time in the tenant's calendar, with elapsed duration independent of zone. */
export interface LeadCreatedTime {
  day: 'today' | 'yesterday' | 'date';
  date: string;
  time: string;
  full: string;
  elapsed: 'now' | 'minutes' | 'hours' | 'days';
  count: number;
}

export function leadCreatedTime(
  iso: string,
  now: number,
  locale: string,
  timeZone = 'UTC',
): LeadCreatedTime | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now)) return null;
  const calendar = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const dayNumber = (value: Date | number): number => {
    const parts = calendar.formatToParts(value);
    const part = (name: string): number =>
      Number(parts.find((p) => p.type === name)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
  };
  const days = dayNumber(now) - dayNumber(date);
  const minutes = Math.floor(Math.max(0, now - date.getTime()) / 60_000);
  const elapsed =
    minutes < 1
      ? 'now'
      : minutes < 60
        ? 'minutes'
        : minutes < 1_440
          ? 'hours'
          : 'days';
  const count =
    elapsed === 'hours'
      ? Math.floor(minutes / 60)
      : elapsed === 'days'
        ? Math.floor(minutes / 1_440)
        : minutes;
  return {
    day: days === 0 ? 'today' : days === 1 ? 'yesterday' : 'date',
    date: new Intl.DateTimeFormat(locale, {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date),
    time: new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date),
    full: new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date),
    elapsed,
    count,
  };
}
