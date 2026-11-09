import { describe, expect, it } from 'vitest';
import {
  canPlayRecording,
  decideHandover,
  decideOutbound,
  recordingRetainUntil,
  tenantMinuteOfDay,
} from './policies.js';

const TZ = 'Asia/Tashkent'; // UTC+5, no DST
const at = (hhmmLocal: string): Date => {
  const [h, m] = hhmmLocal.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 10, h - 5, m));
};

describe('tenant time', () => {
  it('converts to tenant minutes of day', () => {
    expect(tenantMinuteOfDay(at('09:00'), TZ)).toBe(540);
    expect(tenantMinuteOfDay(at('23:59'), TZ)).toBe(23 * 60 + 59);
  });
});

describe('handover policy (V4)', () => {
  const base = { timeZone: TZ, operatorNumber: '+998711111111' };
  it('transfers during 09:00-18:00 tenant time', () => {
    expect(decideHandover({ ...base, now: at('09:00') })).toEqual({
      kind: 'TRANSFER',
      toNumber: '+998711111111',
    });
    expect(decideHandover({ ...base, now: at('17:59') }).kind).toBe('TRANSFER');
  });
  it('creates a callback request outside the hours', () => {
    for (const t of ['08:59', '18:00', '23:30']) {
      expect(decideHandover({ ...base, now: at(t) })).toEqual({
        kind: 'CALLBACK_REQUEST',
        reason: 'AFTER_HOURS',
      });
    }
  });
  it('falls back to a callback when no operator number is configured', () => {
    expect(decideHandover({ timeZone: TZ, now: at('12:00') })).toEqual({
      kind: 'CALLBACK_REQUEST',
      reason: 'NO_OPERATOR_NUMBER',
    });
  });
});

describe('outbound policy (V6)', () => {
  const ok = {
    timeZone: TZ,
    now: at('10:00'),
    hasCallbackOptIn: true,
    callsPlacedToday: 0,
    dailyCap: 5,
  };
  it('allows an opted-in contact inside the window under the cap', () => {
    expect(decideOutbound(ok)).toEqual({ allowed: true });
    expect(decideOutbound({ ...ok, now: at('18:59') }).allowed).toBe(true);
  });
  it('refuses with a typed reason', () => {
    expect(decideOutbound({ ...ok, hasCallbackOptIn: false })).toEqual({
      allowed: false,
      reason: 'NO_OPT_IN_CALLBACK',
    });
    expect(decideOutbound({ ...ok, optedOut: true })).toEqual({
      allowed: false,
      reason: 'CONTACT_OPTED_OUT',
    });
    expect(decideOutbound({ ...ok, now: at('08:59') })).toEqual({
      allowed: false,
      reason: 'OUTSIDE_CALL_WINDOW',
    });
    expect(decideOutbound({ ...ok, now: at('19:00') })).toEqual({
      allowed: false,
      reason: 'OUTSIDE_CALL_WINDOW',
    });
    expect(decideOutbound({ ...ok, callsPlacedToday: 5 })).toEqual({
      allowed: false,
      reason: 'DAILY_CAP_REACHED',
    });
  });
});

describe('recording policy (V5)', () => {
  it('retains for 90 days', () => {
    const start = new Date('2026-11-10T00:00:00Z');
    expect(recordingRetainUntil(start).toISOString()).toBe(
      '2027-02-08T00:00:00.000Z',
    );
  });
  it('allows playback to OWNER and ADMIN only', () => {
    expect(canPlayRecording('OWNER')).toBe(true);
    expect(canPlayRecording('ADMIN')).toBe(true);
    expect(canPlayRecording('OPERATOR')).toBe(false);
    expect(canPlayRecording('VIEWER')).toBe(false);
  });
});
