import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOLLOW_UP_POLICY,
  decideFollowUp,
  inQuietHours,
  localHour,
  type FollowUpCandidate,
} from './policy.js';

const base = (
  overrides: Partial<FollowUpCandidate> = {},
): FollowUpCandidate => ({
  state: 'BOT_ACTIVE',
  lastMessage: {
    direction: 'OUTBOUND',
    author: 'BOT',
    delivered: true,
    at: new Date('2026-11-10T10:00:00.000Z'),
  },
  contact: { marketingOptOut: false, consent: 'UNKNOWN', deleted: false },
  followUpsSent: 0,
  hasValue: true,
  timeZone: 'UTC',
  ...overrides,
});

describe('followup policy', () => {
  it('computes local hour and quiet hours including midnight wrap', () => {
    const now = new Date('2026-11-11T22:30:00.000Z');
    expect(localHour(now, 'UTC')).toBe(22);
    expect(
      inQuietHours(now, 'UTC', { quietStartHour: 21, quietEndHour: 9 }),
    ).toBe(true);
    expect(
      inQuietHours(new Date('2026-11-11T10:00:00.000Z'), 'UTC', {
        quietStartHour: 21,
        quietEndHour: 9,
      }),
    ).toBe(false);
    expect(
      inQuietHours(new Date('2026-11-11T22:00:00.000Z'), 'UTC', {
        quietStartHour: 22,
        quietEndHour: 23,
      }),
    ).toBe(true);
  });

  it('sends when all conditions hold after the wait outside quiet hours', () => {
    const now = new Date('2026-11-11T12:00:00.000Z'); // +26h
    expect(decideFollowUp(base(), now, DEFAULT_FOLLOW_UP_POLICY)).toEqual({
      send: true,
    });
  });

  it('refuses non-bot states, opt-out/revoked/deleted contacts, and no value', () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    expect(decideFollowUp(base({ state: 'WAITING_OPERATOR' }), now)).toEqual({
      send: false,
      reason: 'NOT_BOT_ACTIVE',
      retry: false,
    });
    expect(
      decideFollowUp(
        base({
          contact: {
            marketingOptOut: true,
            consent: 'UNKNOWN',
            deleted: false,
          },
        }),
        now,
      ),
    ).toEqual({ send: false, reason: 'OPTED_OUT', retry: false });
    expect(
      decideFollowUp(
        base({
          contact: {
            marketingOptOut: false,
            consent: 'REVOKED',
            deleted: false,
          },
        }),
        now,
      ),
    ).toEqual({ send: false, reason: 'OPTED_OUT', retry: false });
    expect(
      decideFollowUp(
        base({
          contact: {
            marketingOptOut: false,
            consent: 'UNKNOWN',
            deleted: true,
          },
        }),
        now,
      ),
    ).toEqual({ send: false, reason: 'OPTED_OUT', retry: false });
    expect(decideFollowUp(base({ hasValue: false }), now)).toEqual({
      send: false,
      reason: 'NO_VALUE',
      retry: false,
    });
  });

  it('requires last message to be an outbound delivered bot message', () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    expect(
      decideFollowUp(
        base({
          lastMessage: {
            direction: 'INBOUND',
            author: 'CUSTOMER',
            delivered: true,
            at: new Date('2026-11-10T10:00:00.000Z'),
          },
        }),
        now,
      ),
    ).toEqual({ send: false, reason: 'CUSTOMER_LAST', retry: false });
    expect(
      decideFollowUp(
        base({
          lastMessage: {
            direction: 'OUTBOUND',
            author: 'BOT',
            delivered: false,
            at: new Date('2026-11-10T10:00:00.000Z'),
          },
        }),
        now,
      ),
    ).toEqual({ send: false, reason: 'NOT_DELIVERED', retry: false });
  });

  it('enforces per-conversation limit and exponential wait with retryable outcomes', () => {
    const now = new Date('2026-11-11T12:00:00.000Z'); // 26h after base
    expect(
      decideFollowUp(base({ followUpsSent: 1 }), now, {
        ...DEFAULT_FOLLOW_UP_POLICY,
        maxPerConversation: 1,
      }),
    ).toEqual({ send: false, reason: 'LIMIT_REACHED', retry: false });
    // 1 follow-up already sent => wait doubles (48h), 26h is too early
    expect(
      decideFollowUp(base({ followUpsSent: 1 }), now, {
        ...DEFAULT_FOLLOW_UP_POLICY,
        maxPerConversation: 2,
      }),
    ).toEqual({ send: false, reason: 'TOO_EARLY', retry: true });
  });

  it('defers during quiet hours with retry', () => {
    const now = new Date('2026-11-11T22:30:00.000Z');
    const lastAt = new Date('2026-11-10T20:00:00.000Z'); // >24h ago
    expect(
      decideFollowUp(
        base({
          lastMessage: {
            direction: 'OUTBOUND',
            author: 'BOT',
            delivered: true,
            at: lastAt,
          },
        }),
        now,
      ),
    ).toEqual({ send: false, reason: 'QUIET_HOURS', retry: true });
  });
});
