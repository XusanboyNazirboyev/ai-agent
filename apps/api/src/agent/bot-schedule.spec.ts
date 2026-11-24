import { describe, expect, it } from 'vitest';
import {
  ALWAYS,
  botOnDuty,
  botScheduleOf,
  type BotSchedule,
} from './bot-schedule.js';

const TZ = 'Asia/Tashkent'; // UTC+5, no DST
/** A Tashkent wall-clock time on 2026-11-23 (Monday) + `dayOffset`. */
const at = (clock: string, dayOffset = 0): Date =>
  new Date(
    Date.UTC(
      2026,
      10,
      23 + dayOffset,
      Number(clock.slice(0, 2)) - 5,
      Number(clock.slice(3)),
    ),
  );

const workDays: BotSchedule = {
  mode: 'off_hours',
  days: [1, 2, 3, 4, 5],
  from: '09:00',
  to: '18:00',
};

describe('bot schedule (ADR 089)', () => {
  it('always answers by default and on anything unreadable', () => {
    expect(botScheduleOf(null)).toEqual(ALWAYS);
    expect(botScheduleOf({ botSchedule: { mode: 'nope' } })).toEqual(ALWAYS);
    expect(
      botScheduleOf({
        botSchedule: {
          mode: 'work_hours',
          days: [],
          from: '09:00',
          to: '18:00',
        },
      }),
    ).toEqual(ALWAYS);
    expect(botOnDuty(ALWAYS, at('03:00'), TZ)).toBe(true);
  });

  it('off_hours: silent inside the working window, on duty outside it', () => {
    expect(botOnDuty(workDays, at('08:59'), TZ)).toBe(true);
    expect(botOnDuty(workDays, at('09:00'), TZ)).toBe(false);
    expect(botOnDuty(workDays, at('17:59'), TZ)).toBe(false);
    expect(botOnDuty(workDays, at('18:00'), TZ)).toBe(true);
    // Saturday is not a working day.
    expect(botOnDuty(workDays, at('12:00', 5), TZ)).toBe(true);
  });

  it('work_hours is the opposite', () => {
    const s = { ...workDays, mode: 'work_hours' as const };
    expect(botOnDuty(s, at('12:00'), TZ)).toBe(true);
    expect(botOnDuty(s, at('20:00'), TZ)).toBe(false);
    expect(botOnDuty(s, at('12:00', 6), TZ)).toBe(false);
  });

  it('a window past midnight belongs to the day it starts', () => {
    // Night shift Friday 22:00 to Saturday 06:00 only.
    const night: BotSchedule = {
      mode: 'work_hours',
      days: [5],
      from: '22:00',
      to: '06:00',
    };
    expect(botOnDuty(night, at('23:00', 4), TZ)).toBe(true); // Fri
    expect(botOnDuty(night, at('05:59', 5), TZ)).toBe(true); // Sat
    expect(botOnDuty(night, at('06:00', 5), TZ)).toBe(false);
    expect(botOnDuty(night, at('23:00', 5), TZ)).toBe(false); // Sat night
    expect(botOnDuty(night, at('05:00', 4), TZ)).toBe(false); // Fri morning
  });

  it('uses the tenant time zone, not the server clock', () => {
    // 12:00 in Tashkent is 07:00 UTC; in UTC the window is closed.
    expect(botOnDuty(workDays, at('12:00'), TZ)).toBe(false);
    expect(botOnDuty(workDays, at('12:00'), 'UTC')).toBe(true);
  });
});
