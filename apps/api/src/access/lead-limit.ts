import type { Prisma } from '../generated/prisma/client.js';

/** ADR 080: thresholds (percent of `monthlyNewLeads`) that send one warning each. */
export const LEAD_LIMIT_THRESHOLDS = [80, 100] as const;

function parts(at: Date, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at))
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  return out;
}

/** Offset of `timeZone` from UTC at `at`, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  const asUtc = Date.UTC(
    p.year!,
    p.month! - 1,
    p.day!,
    p.hour!,
    p.minute!,
    p.second!,
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Calendar month (`YYYY-MM`) of `now` in the tenant's time zone. */
export function localMonth(now: Date, timeZone: string): string {
  const p = parts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** The instant the current calendar month began in the tenant's time zone. */
export function monthStartInZone(now: Date, timeZone: string): Date {
  const p = parts(now, timeZone);
  const localMidnight = Date.UTC(p.year!, p.month! - 1, 1);
  // Two passes so a month starting across a DST change still lands right.
  let guess = localMidnight - zoneOffsetMs(new Date(localMidnight), timeZone);
  guess = localMidnight - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** The highest threshold (80 or 100) the count has reached; 0 below 80 %. */
export function reachedThreshold(count: number, limit: number): 0 | 80 | 100 {
  if (!Number.isInteger(limit) || limit <= 0 || count < 0) return 0;
  if (count >= limit) return 100;
  if (count * 100 >= limit * 80) return 80;
  return 0;
}

type LeadDb = Pick<Prisma.TransactionClient, 'lead'>;

/** Leads created this calendar month (tenant time zone), archived ones included. */
export async function countNewLeadsThisMonth(
  db: LeadDb,
  tenantId: string,
  timeZone: string,
  now: Date,
): Promise<number> {
  return db.lead.count({
    where: { tenantId, createdAt: { gte: monthStartInZone(now, timeZone) } },
  });
}
