import { describe, expect, it } from 'vitest';
import {
  decideFollowUp,
  DEFAULT_FOLLOW_UP_POLICY,
  inQuietHours,
  localHour,
  type FollowUpCandidate,
} from '../core/followup/policy.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { EN, RU, UZ_CYRL, UZ_LATN } from '../locales/locale-packs.js';
import { runTurn } from './testing/agent-harness.js';

const NOW = new Date('2026-10-26T07:00:00Z');
const base: FollowUpCandidate = {
  state: 'BOT_ACTIVE',
  lastMessage: {
    direction: 'OUTBOUND',
    author: 'BOT',
    delivered: true,
    at: new Date(NOW.getTime() - 30 * 3_600_000),
  },
  contact: { marketingOptOut: false, consent: 'UNKNOWN', deleted: false },
  followUpsSent: 0,
  hasValue: true,
  timeZone: 'Asia/Tashkent',
};

describe('follow-up policy', () => {
  it('sends when every condition holds', () => {
    expect(decideFollowUp(base, NOW)).toEqual({ send: true });
  });

  it('refuses, with a reason and whether to retry', () => {
    const cases: Array<[Partial<FollowUpCandidate>, string, boolean]> = [
      [{ state: 'WAITING_OPERATOR' }, 'NOT_BOT_ACTIVE', false],
      [
        { contact: { ...base.contact, marketingOptOut: true } },
        'OPTED_OUT',
        false,
      ],
      [
        { contact: { ...base.contact, consent: 'REVOKED' } },
        'OPTED_OUT',
        false,
      ],
      [{ contact: { ...base.contact, deleted: true } }, 'OPTED_OUT', false],
      [
        {
          lastMessage: {
            ...base.lastMessage,
            direction: 'INBOUND',
            author: 'CUSTOMER',
          },
        },
        'CUSTOMER_LAST',
        false,
      ],
      [
        { lastMessage: { ...base.lastMessage, author: 'OPERATOR' } },
        'CUSTOMER_LAST',
        false,
      ],
      [
        { lastMessage: { ...base.lastMessage, delivered: false } },
        'NOT_DELIVERED',
        false,
      ],
      [{ hasValue: false }, 'NO_VALUE', false],
      [{ followUpsSent: 1 }, 'LIMIT_REACHED', false],
      [
        {
          lastMessage: {
            ...base.lastMessage,
            at: new Date(NOW.getTime() - 3_600_000),
          },
        },
        'TOO_EARLY',
        true,
      ],
    ];
    for (const [over, reason, retry] of cases)
      expect(decideFollowUp({ ...base, ...over }, NOW)).toEqual({
        send: false,
        reason,
        retry,
      });
  });

  it('applies quiet hours in the tenant time zone, including wrap-around', () => {
    expect(localHour(NOW, 'Asia/Tashkent')).toBe(12);
    expect(localHour(NOW, 'America/New_York')).toBe(3);
    const policy = DEFAULT_FOLLOW_UP_POLICY;
    expect(
      inQuietHours(new Date('2026-10-26T18:30:00Z'), 'Asia/Tashkent', policy),
    ).toBe(true); // 23:30
    expect(
      inQuietHours(new Date('2026-10-26T03:00:00Z'), 'Asia/Tashkent', policy),
    ).toBe(true); // 08:00
    expect(inQuietHours(NOW, 'Asia/Tashkent', policy)).toBe(false); // 12:00
    expect(inQuietHours(NOW, 'America/New_York', policy)).toBe(true); // 03:00 there
    expect(
      inQuietHours(NOW, 'UTC', { quietStartHour: 6, quietEndHour: 8 }),
    ).toBe(true);
    const evening = new Date('2026-10-26T18:30:00Z');
    expect(decideFollowUp(base, evening)).toMatchObject({
      send: false,
      reason: 'QUIET_HOURS',
      retry: true,
    });
  });

  it('waits twice as long for each further follow-up', () => {
    const two = { ...DEFAULT_FOLLOW_UP_POLICY, maxPerConversation: 2 };
    const second = { ...base, followUpsSent: 1 };
    expect(decideFollowUp(second, NOW, two)).toMatchObject({
      reason: 'TOO_EARLY',
    }); // 30 h < 48 h
    const older = {
      ...second,
      lastMessage: {
        ...base.lastMessage,
        at: new Date(NOW.getTime() - 50 * 3_600_000),
      },
    };
    expect(decideFollowUp(older, NOW, two)).toEqual({ send: true });
  });
});

describe('opt-out (Tier-0, before any model call)', () => {
  it.each([
    ['/stop'],
    ['Stop!'],
    ['  STOP  '],
    ['стоп'],
    ['Не пишите'],
    ["to'xtat"],
    ['тўхтат'],
    ['unsubscribe.'],
  ])('honours %j with the confirmation and no model call', async (text) => {
    const provider = new ScriptedLlmProvider([]);
    const { result } = await runTurn({ provider, text });
    expect(result.optOut).toBe(true);
    expect(result.outcome).toBe('ANSWERED');
    expect(provider.calls).toHaveLength(0);
    expect(
      [UZ_LATN, UZ_CYRL, RU, EN].map((p) => p.templates.optOutConfirmation),
    ).toContain(result.reply);
  });

  it.each([
    ['please stop by the office tomorrow'],
    ['Stop 3 course price?'],
    ['stopwatch'],
    ['bu to‘xtatma narxi'],
  ])('does not read the sentence %j as an opt-out', async (text) => {
    const provider = new ScriptedLlmProvider([]);
    const { result } = await runTurn({ provider, text }).catch(() => ({
      result: { optOut: undefined },
    }));
    expect(result.optOut).toBeUndefined();
  });

  it('keeps reminders text honest: no digits, tells how to stop', () => {
    for (const pack of [UZ_LATN, UZ_CYRL, RU, EN]) {
      expect(pack.templates.followUp).toContain('/stop');
      expect(pack.templates.followUp).not.toMatch(/\d/u);
      expect(pack.templates.optOutConfirmation).not.toMatch(/\d/u);
    }
  });
});
