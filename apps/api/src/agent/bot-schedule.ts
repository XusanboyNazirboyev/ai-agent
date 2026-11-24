import { z } from 'zod';

const Clock = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u);

/**
 * ADR 089: when the bot answers. `days` are ISO weekdays (1 Monday … 7
 * Sunday) on which the working window starts; `from` after `to` runs past
 * midnight into the next day.
 */
export const BotScheduleSchema = z
  .object({
    mode: z.enum(['always', 'off_hours', 'work_hours']),
    days: z.array(z.number().int().min(1).max(7)).max(7),
    from: Clock,
    to: Clock,
  })
  .refine((s) => s.mode === 'always' || (s.days.length > 0 && s.from !== s.to));
export type BotSchedule = z.infer<typeof BotScheduleSchema>;

export const ALWAYS: BotSchedule = {
  mode: 'always',
  days: [1, 2, 3, 4, 5, 6],
  from: '09:00',
  to: '18:00',
};

/** The tenant's schedule from `config.botSchedule`; anything unreadable is "always". */
export function botScheduleOf(config: unknown): BotSchedule {
  const raw = (config as { botSchedule?: unknown } | null)?.botSchedule;
  const parsed = BotScheduleSchema.safeParse(raw);
  return parsed.success
    ? {
        ...parsed.data,
        days: [...new Set(parsed.data.days)].sort((a, b) => a - b),
      }
    : ALWAYS;
}

const WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function localClock(
  now: Date,
  timeZone: string,
): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: WEEKDAY[part('weekday')] ?? 1,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

const minutesOf = (clock: string): number =>
  Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Inside the business's working window at `now`, in its time zone. */
export function inWorkingWindow(
  schedule: BotSchedule,
  now: Date,
  timeZone: string,
): boolean {
  const { weekday, minutes } = localClock(now, timeZone);
  const from = minutesOf(schedule.from);
  const to = minutesOf(schedule.to);
  if (from < to)
    return schedule.days.includes(weekday) && minutes >= from && minutes < to;
  const yesterday = weekday === 1 ? 7 : weekday - 1;
  return (
    (schedule.days.includes(weekday) && minutes >= from) ||
    (schedule.days.includes(yesterday) && minutes < to)
  );
}

/** Whether the bot may answer a customer at `now`. */
export function botOnDuty(
  schedule: BotSchedule,
  now: Date,
  timeZone: string,
): boolean {
  if (schedule.mode === 'always') return true;
  const working = inWorkingWindow(schedule, now, timeZone);
  return schedule.mode === 'work_hours' ? working : !working;
}
