/**
 * ADR 046 slot engine: a pure function, no I/O. Working hours are evaluated
 * in the staff member's timezone (DST-correct, via Intl) and the result is
 * absolute UTC instants.
 */

export interface SlotService {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  leadTimeMinutes: number;
  requiredSkills: readonly string[];
}

/** Weekly working window; weekday 1 = Monday .. 7 = Sunday; times 'HH:mm'. */
export interface SlotRule {
  weekday: number;
  startTime: string;
  endTime: string;
  /** Local dates 'YYYY-MM-DD', inclusive; null = unbounded. */
  validFrom?: string | null;
  validUntil?: string | null;
}

/** Local date range; no times = the whole day(s). */
export interface SlotException {
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
  /** true removes working time; false adds extra working time. */
  unavailable: boolean;
}

export interface SlotStaff {
  id: string;
  skills: readonly string[];
  /** IANA zone; null falls back to `tenantTimezone`. */
  timezone?: string | null;
  rules: readonly SlotRule[];
  exceptions: readonly SlotException[];
}

/** An existing HELD/CONFIRMED appointment, buffers included. */
export interface BlockedRange {
  staffId: string;
  from: Date;
  until: Date;
}

export interface SlotQuery {
  service: SlotService;
  staff: readonly SlotStaff[];
  blocked: readonly BlockedRange[];
  now: Date;
  /** Search window; a slot qualifies when startsAt is in [from, to). */
  from: Date;
  to: Date;
  tenantTimezone: string;
  gridMinutes?: number;
  maxResults?: number;
}

export interface Slot {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  blockedFrom: Date;
  blockedUntil: Date;
}

const MINUTE = 60_000;
const DAY_MINUTES = 1_440;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset (ms) of `timeZone` from UTC at the instant `ms`. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms)))
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Local calendar date 'YYYY-MM-DD' of an instant in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): string {
  const ms = instant.getTime() + zoneOffsetMs(instant.getTime(), timeZone);
  return new Date(ms).toISOString().slice(0, 10);
}

function dateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m! - 1, d!];
}

/** ISO weekday (1 = Monday .. 7 = Sunday) of a calendar date. */
export function isoWeekday(date: string): number {
  const [y, m, d] = dateParts(date);
  const wd = new Date(Date.UTC(y, m, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = dateParts(date);
  return new Date(Date.UTC(y, m, d + days)).toISOString().slice(0, 10);
}

/**
 * Local wall-clock (date + minutes since midnight) to a UTC instant. In a
 * DST gap the time moves forward; in an overlap the earlier instant wins.
 */
export function zonedToUtc(
  date: string,
  minutes: number,
  timeZone: string,
): number {
  const [y, m, d] = dateParts(date);
  const wall = Date.UTC(y, m, d) + minutes * MINUTE;
  const g1 = wall - zoneOffsetMs(wall, timeZone);
  const g2 = wall - zoneOffsetMs(g1, timeZone);
  const valid = [g1, g2].filter((c) => c + zoneOffsetMs(c, timeZone) === wall);
  if (valid.length > 0) return Math.min(...valid);
  return Math.max(g1, g2); // DST gap: the wall time does not exist
}

function parseTime(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h! * 60 + m!;
}

type Interval = [number, number];

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push([cur[0], cur[1]]);
  }
  return out;
}

function subtractIntervals(base: Interval[], cut: Interval[]): Interval[] {
  let result = base;
  for (const [cs, ce] of mergeIntervals(cut)) {
    const next: Interval[] = [];
    for (const [s, e] of result) {
      if (ce <= s || cs >= e) next.push([s, e]);
      else {
        if (cs > s) next.push([s, cs]);
        if (ce < e) next.push([ce, e]);
      }
    }
    result = next;
  }
  return result;
}

function dayWindow(
  date: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  timeZone: string,
): Interval | null {
  const start = startTime ? parseTime(startTime) : 0;
  const end = endTime ? parseTime(endTime) : DAY_MINUTES;
  const s = zonedToUtc(date, start, timeZone);
  const e = zonedToUtc(date, end, timeZone);
  return e > s ? [s, e] : null;
}

/** Free working intervals (UTC ms) of one staff member on one local date. */
function freeIntervals(
  staff: SlotStaff,
  date: string,
  timeZone: string,
): Interval[] {
  const weekday = isoWeekday(date);
  const add: Interval[] = [];
  const cut: Interval[] = [];
  for (const r of staff.rules) {
    if (r.weekday !== weekday) continue;
    if (r.validFrom && date < r.validFrom) continue;
    if (r.validUntil && date > r.validUntil) continue;
    const w = dayWindow(date, r.startTime, r.endTime, timeZone);
    if (w) add.push(w);
  }
  for (const x of staff.exceptions) {
    if (date < x.startDate || date > x.endDate) continue;
    const w = dayWindow(date, x.startTime, x.endTime, timeZone);
    if (!w) continue;
    (x.unavailable ? cut : add).push(w);
  }
  return subtractIntervals(mergeIntervals(add), cut);
}

export function findSlots(query: SlotQuery): Slot[] {
  const { service, now, from, to } = query;
  const grid = query.gridMinutes ?? 15;
  const maxResults = query.maxResults ?? 50;
  if (grid <= 0 || maxResults <= 0 || service.durationMinutes <= 0) return [];
  if (to <= from) return [];

  const earliest = Math.max(
    from.getTime(),
    now.getTime() + service.leadTimeMinutes * MINUTE,
  );
  const lastStart = to.getTime();
  const durationMs = service.durationMinutes * MINUTE;
  const beforeMs = service.bufferBeforeMinutes * MINUTE;
  const afterMs = service.bufferAfterMinutes * MINUTE;

  interface Ranked extends Slot {
    load: number;
  }
  const ranked: Ranked[] = [];

  for (const staff of query.staff) {
    if (!service.requiredSkills.every((s) => staff.skills.includes(s)))
      continue;
    const tz = staff.timezone ?? query.tenantTimezone;
    const mine = query.blocked
      .filter((b) => b.staffId === staff.id)
      .map((b): Interval => [b.from.getTime(), b.until.getTime()]);

    // Minutes already booked per local date (for the least-loaded ranking).
    const loadByDate = new Map<string, number>();
    for (const [s, e] of mine) {
      const day = localDateOf(new Date(s), tz);
      loadByDate.set(day, (loadByDate.get(day) ?? 0) + (e - s) / MINUTE);
    }

    const firstDate = addDays(localDateOf(new Date(earliest), tz), -1);
    const lastDate = addDays(localDateOf(new Date(lastStart), tz), 1);
    for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
      const free = freeIntervals(staff, date, tz);
      if (free.length === 0) continue;
      for (let m = 0; m < DAY_MINUTES; m += grid) {
        const start = zonedToUtc(date, m, tz);
        // Skip the repeated hour of a DST overlap and out-of-window starts.
        if (localDateOf(new Date(start), tz) !== date) continue;
        if (start < earliest || start >= lastStart) continue;
        const bFrom = start - beforeMs;
        const bUntil = start + durationMs + afterMs;
        if (!free.some(([s, e]) => s <= bFrom && bUntil <= e)) continue;
        if (mine.some(([s, e]) => bFrom < e && s < bUntil)) continue;
        ranked.push({
          staffId: staff.id,
          startsAt: new Date(start),
          endsAt: new Date(start + durationMs),
          blockedFrom: new Date(bFrom),
          blockedUntil: new Date(bUntil),
          load: loadByDate.get(date) ?? 0,
        });
      }
    }
  }

  const seen = new Set<string>();
  return ranked
    .sort(
      (a, b) =>
        a.startsAt.getTime() - b.startsAt.getTime() ||
        a.load - b.load ||
        a.staffId.localeCompare(b.staffId),
    )
    .filter((s) => {
      const key = `${s.staffId}|${s.startsAt.getTime()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxResults)
    .map(({ load: _load, ...slot }) => slot);
}
