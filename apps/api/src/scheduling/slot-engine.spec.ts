import { describe, expect, it } from 'vitest';
import {
  findSlots,
  isoWeekday,
  localDateOf,
  zonedToUtc,
  type SlotQuery,
  type SlotStaff,
} from './slot-engine.js';

const iso = (d: Date): string => d.toISOString();
const utc = (s: string): Date => new Date(s);

function staff(over: Partial<SlotStaff> = {}): SlotStaff {
  return {
    id: 'a',
    skills: ['repair'],
    timezone: 'Asia/Tashkent', // UTC+5, no DST
    rules: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }],
    exceptions: [],
    ...over,
  };
}

// 2026-11-09 is a Monday.
function query(over: Partial<SlotQuery> = {}): SlotQuery {
  return {
    service: {
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      leadTimeMinutes: 0,
      requiredSkills: [],
    },
    staff: [staff()],
    blocked: [],
    now: utc('2026-11-08T00:00:00Z'),
    from: utc('2026-11-09T00:00:00Z'),
    to: utc('2026-11-10T00:00:00Z'),
    tenantTimezone: 'Asia/Tashkent',
    ...over,
  };
}

describe('time zone helpers', () => {
  it('converts Tashkent wall time to UTC', () => {
    expect(
      iso(new Date(zonedToUtc('2026-11-09', 9 * 60, 'Asia/Tashkent'))),
    ).toBe('2026-11-09T04:00:00.000Z');
    expect(localDateOf(utc('2026-11-09T20:00:00Z'), 'Asia/Tashkent')).toBe(
      '2026-11-10',
    );
  });
  it('handles Europe/Berlin across the March change', () => {
    // CET (+1) before 2026-03-29, CEST (+2) after.
    expect(iso(new Date(zonedToUtc('2026-03-28', 600, 'Europe/Berlin')))).toBe(
      '2026-03-28T09:00:00.000Z',
    );
    expect(iso(new Date(zonedToUtc('2026-03-30', 600, 'Europe/Berlin')))).toBe(
      '2026-03-30T08:00:00.000Z',
    );
    // 02:30 does not exist on 2026-03-29; it moves forward to 03:30 CEST.
    expect(iso(new Date(zonedToUtc('2026-03-29', 150, 'Europe/Berlin')))).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });
  it('returns ISO weekdays', () => {
    expect(isoWeekday('2026-11-09')).toBe(1);
    expect(isoWeekday('2026-11-15')).toBe(7);
  });
});

describe('findSlots', () => {
  it('lists grid slots that fit inside working hours', () => {
    const slots = findSlots(query());
    // 09:00-12:00 local, 60 min service, 15 min grid: 09:00 .. 11:00.
    expect(slots).toHaveLength(9);
    expect(iso(slots[0]!.startsAt)).toBe('2026-11-09T04:00:00.000Z');
    expect(iso(slots[8]!.startsAt)).toBe('2026-11-09T06:00:00.000Z');
    expect(iso(slots[8]!.endsAt)).toBe('2026-11-09T07:00:00.000Z');
  });

  it('keeps buffers inside working hours at both day edges', () => {
    const slots = findSlots(
      query({
        service: {
          durationMinutes: 60,
          bufferBeforeMinutes: 30,
          bufferAfterMinutes: 15,
          leadTimeMinutes: 0,
          requiredSkills: [],
        },
      }),
    );
    // Earliest start 09:30 (30 min before), latest end 11:45 (15 min after).
    expect(iso(slots[0]!.startsAt)).toBe('2026-11-09T04:30:00.000Z');
    expect(iso(slots[0]!.blockedFrom)).toBe('2026-11-09T04:00:00.000Z');
    const last = slots[slots.length - 1]!;
    expect(iso(last.startsAt)).toBe('2026-11-09T05:45:00.000Z');
    expect(iso(last.blockedUntil)).toBe('2026-11-09T07:00:00.000Z');
  });

  it('respects the lead time measured from now', () => {
    const slots = findSlots(
      query({
        now: utc('2026-11-09T03:00:00Z'), // 08:00 local
        service: {
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          leadTimeMinutes: 90,
          requiredSkills: [],
        },
      }),
    );
    expect(iso(slots[0]!.startsAt)).toBe('2026-11-09T04:30:00.000Z');
  });

  it('requires every required skill', () => {
    const q = query({
      service: {
        durationMinutes: 60,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        leadTimeMinutes: 0,
        requiredSkills: ['repair', 'gas'],
      },
    });
    expect(findSlots(q)).toHaveLength(0);
    const ok = findSlots({
      ...q,
      staff: [staff({ skills: ['repair', 'gas', 'extra'] })],
    });
    expect(ok.length).toBeGreaterThan(0);
  });

  it('does not overlap existing blocked ranges (half-open)', () => {
    const slots = findSlots(
      query({
        blocked: [
          {
            staffId: 'a',
            from: utc('2026-11-09T05:00:00Z'),
            until: utc('2026-11-09T06:00:00Z'),
          },
        ],
      }),
    );
    const starts = slots.map((s) => iso(s.startsAt));
    // A slot may end exactly when the blocked range starts, or start when it ends.
    expect(starts).toContain('2026-11-09T04:00:00.000Z');
    expect(starts).toContain('2026-11-09T06:00:00.000Z');
    expect(starts).not.toContain('2026-11-09T04:15:00.000Z');
    expect(starts).not.toContain('2026-11-09T05:30:00.000Z');
    expect(starts).not.toContain('2026-11-09T05:45:00.000Z');
  });

  it('removes time for an unavailable exception', () => {
    const slots = findSlots(
      query({
        staff: [
          staff({
            exceptions: [
              {
                startDate: '2026-11-09',
                endDate: '2026-11-09',
                startTime: '10:00',
                endTime: '11:00',
                unavailable: true,
              },
            ],
          }),
        ],
      }),
    );
    const starts = slots.map((s) => iso(s.startsAt));
    expect(starts).toContain('2026-11-09T04:00:00.000Z'); // 09:00-10:00
    expect(starts).toContain('2026-11-09T06:00:00.000Z'); // 11:00-12:00
    expect(starts).not.toContain('2026-11-09T05:00:00.000Z');
    expect(starts).not.toContain('2026-11-09T04:30:00.000Z');
  });

  it('removes a whole day for a leave without times', () => {
    const slots = findSlots(
      query({
        staff: [
          staff({
            exceptions: [
              {
                startDate: '2026-11-08',
                endDate: '2026-11-10',
                unavailable: true,
              },
            ],
          }),
        ],
      }),
    );
    expect(slots).toHaveLength(0);
  });

  it('adds time for an extra-hours exception on a non-working day', () => {
    const slots = findSlots(
      query({
        from: utc('2026-11-10T00:00:00Z'), // Tuesday: no rule
        to: utc('2026-11-11T00:00:00Z'),
        staff: [
          staff({
            exceptions: [
              {
                startDate: '2026-11-10',
                endDate: '2026-11-10',
                startTime: '14:00',
                endTime: '16:00',
                unavailable: false,
              },
            ],
          }),
        ],
      }),
    );
    expect(iso(slots[0]!.startsAt)).toBe('2026-11-10T09:00:00.000Z');
    expect(slots).toHaveLength(5);
  });

  it('respects validFrom and validUntil of a rule', () => {
    const rule = (
      validFrom: string | null,
      validUntil: string | null,
    ): SlotStaff =>
      staff({
        rules: [
          {
            weekday: 1,
            startTime: '09:00',
            endTime: '12:00',
            validFrom,
            validUntil,
          },
        ],
      });
    expect(
      findSlots(query({ staff: [rule('2026-11-10', null)] })),
    ).toHaveLength(0);
    expect(
      findSlots(query({ staff: [rule(null, '2026-11-08')] })),
    ).toHaveLength(0);
    expect(
      findSlots(query({ staff: [rule('2026-11-09', '2026-11-09')] })).length,
    ).toBeGreaterThan(0);
  });

  it('merges adjacent rules so a slot can span them', () => {
    const slots = findSlots(
      query({
        staff: [
          staff({
            rules: [
              { weekday: 1, startTime: '09:00', endTime: '10:00' },
              { weekday: 1, startTime: '10:00', endTime: '11:00' },
            ],
          }),
        ],
      }),
    );
    expect(slots.map((s) => iso(s.startsAt))).toContain(
      '2026-11-09T04:30:00.000Z',
    );
  });

  it('computes Berlin working hours on both sides of the March change', () => {
    const berlin = staff({
      id: 'b',
      timezone: 'Europe/Berlin',
      rules: [
        { weekday: 6, startTime: '10:00', endTime: '11:00' }, // Saturday
        { weekday: 1, startTime: '10:00', endTime: '11:00' }, // Monday
      ],
    });
    const slots = findSlots(
      query({
        staff: [berlin],
        tenantTimezone: 'Europe/Berlin',
        now: utc('2026-03-20T00:00:00Z'),
        from: utc('2026-03-28T00:00:00Z'),
        to: utc('2026-03-31T00:00:00Z'),
      }),
    );
    const starts = slots.map((s) => iso(s.startsAt));
    // Sat 28th is CET (10:00 = 09:00Z); Mon 30th is CEST (10:00 = 08:00Z).
    expect(starts[0]).toBe('2026-03-28T09:00:00.000Z');
    expect(starts).toContain('2026-03-30T08:00:00.000Z');
    expect(starts.filter((x) => x.startsWith('2026-03-29'))).toHaveLength(0);
  });

  it('handles a working day that contains the DST change (23h day)', () => {
    const berlin = staff({
      id: 'b',
      timezone: 'Europe/Berlin',
      rules: [{ weekday: 7, startTime: '01:00', endTime: '04:00' }], // Sunday 29th
    });
    const slots = findSlots(
      query({
        staff: [berlin],
        tenantTimezone: 'Europe/Berlin',
        now: utc('2026-03-20T00:00:00Z'),
        from: utc('2026-03-29T00:00:00Z'),
        to: utc('2026-03-30T00:00:00Z'),
        service: {
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          leadTimeMinutes: 0,
          requiredSkills: [],
        },
      }),
    );
    // 01:00 CET = 00:00Z; 04:00 CEST = 02:00Z -> only two real hours.
    const last = slots[slots.length - 1]!;
    expect(iso(slots[0]!.startsAt)).toBe('2026-03-29T00:00:00.000Z');
    expect(iso(last.endsAt)).toBe('2026-03-29T02:00:00.000Z');
  });

  it('ranks earliest first, then the least-loaded staff member', () => {
    const slots = findSlots(
      query({
        staff: [staff({ id: 'busy' }), staff({ id: 'idle' })],
        blocked: [
          {
            staffId: 'busy',
            from: utc('2026-11-09T06:00:00Z'),
            until: utc('2026-11-09T07:00:00Z'),
          },
        ],
        maxResults: 3,
      }),
    );
    expect(
      slots.map((s) => `${s.staffId}@${iso(s.startsAt).slice(11, 16)}`),
    ).toEqual(['idle@04:00', 'busy@04:00', 'idle@04:15']);
  });

  it('caps the number of results', () => {
    expect(findSlots(query({ maxResults: 2 }))).toHaveLength(2);
    expect(findSlots(query({ maxResults: 0 }))).toHaveLength(0);
  });

  it('supports a 30 minute grid', () => {
    const slots = findSlots(query({ gridMinutes: 30 }));
    expect(slots.map((s) => iso(s.startsAt).slice(11, 16))).toEqual([
      '04:00',
      '04:30',
      '05:00',
      '05:30',
      '06:00',
    ]);
  });
});
