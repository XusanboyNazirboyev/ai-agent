import { describe, expect, it } from 'vitest';
import {
  botMaySpeak,
  nextState,
  operatorMaySpeak,
  type ConversationState,
  type OwnershipCommand,
} from '../core/handover/state-machine.js';
import {
  DEFAULT_STUCK_POLICY,
  detectStuck,
  textFingerprint,
  type PriorTurnSignal,
} from '../core/agent/stuck.js';
import { decimalAtLeast } from '../core/agent/money.js';
import { scoreLead } from '../core/leads/scoring.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { DomainPackSchema } from '@agentcore/shared';
import { extraction, runTurn } from './testing/agent-harness.js';

describe('ownership state machine', () => {
  const legal: Array<[ConversationState, OwnershipCommand, ConversationState]> =
    [
      ['BOT_ACTIVE', 'HANDOVER', 'WAITING_OPERATOR'],
      ['WAITING_OPERATOR', 'TAKE_OVER', 'OPERATOR_ACTIVE'],
      ['OPERATOR_ACTIVE', 'RETURN_TO_BOT', 'BOT_ACTIVE'],
      ['WAITING_OPERATOR', 'RETURN_TO_BOT', 'BOT_ACTIVE'],
      ['BOT_ACTIVE', 'CLOSE', 'CLOSED'],
      ['WAITING_OPERATOR', 'CLOSE', 'CLOSED'],
      ['OPERATOR_ACTIVE', 'CLOSE', 'CLOSED'],
      ['CLOSED', 'REOPEN', 'BOT_ACTIVE'],
    ];
  it.each(legal)('%s + %s -> %s', (from, command, to) => {
    expect(nextState(from, command)).toBe(to);
  });

  it('rejects every other combination', () => {
    const states: ConversationState[] = [
      'BOT_ACTIVE',
      'WAITING_OPERATOR',
      'OPERATOR_ACTIVE',
      'CLOSED',
    ];
    const commands: OwnershipCommand[] = [
      'HANDOVER',
      'TAKE_OVER',
      'RETURN_TO_BOT',
      'CLOSE',
      'REOPEN',
    ];
    for (const state of states)
      for (const command of commands) {
        const allowed = legal.some(([s, c]) => s === state && c === command);
        expect(
          nextState(state, command) !== undefined,
          `${state} ${command}`,
        ).toBe(allowed);
      }
  });

  it('lets only the owner speak', () => {
    expect(botMaySpeak('BOT_ACTIVE')).toBe(true);
    for (const state of [
      'WAITING_OPERATOR',
      'OPERATOR_ACTIVE',
      'CLOSED',
    ] as const)
      expect(botMaySpeak(state)).toBe(false);
    expect(operatorMaySpeak('OPERATOR_ACTIVE')).toBe(true);
    expect(operatorMaySpeak('WAITING_OPERATOR')).toBe(false);
    expect(operatorMaySpeak('BOT_ACTIVE')).toBe(false);
  });
});

describe('STUCK detection', () => {
  const asked = (slot: string, filled = 0, fp = 'a'): PriorTurnSignal => ({
    outcome: 'ASKED_SLOT',
    askedSlot: slot,
    slotsFilled: filled,
    textFingerprint: fp,
  });
  const now = (
    slot: string,
    filled = 0,
    fp = 'a',
  ): Parameters<typeof detectStuck>[1] => ({
    outcome: 'ASKED_SLOT',
    askedSlot: slot,
    slotsFilled: filled,
    textFingerprint: fp,
  });

  it('fires when the same question was asked twice and nothing changed', () => {
    expect(
      detectStuck([asked('subject'), asked('subject')], now('subject')),
    ).toBe('SAME_QUESTION_REPEATED');
  });

  it('does not fire on the first or second ask', () => {
    expect(detectStuck([], now('subject'))).toBeUndefined();
    expect(detectStuck([asked('subject')], now('subject'))).toBeUndefined();
  });

  it('does not fire while the customer is making progress', () => {
    // A slot was filled in between: the conversation is moving.
    expect(
      detectStuck(
        [asked('subject', 0), asked('subject', 0)],
        now('subject', 1),
      ),
    ).toBeUndefined();
    // Different question each time.
    expect(
      detectStuck(
        [asked('subject', 0, 'p'), asked('level', 0, 'q')],
        now('format', 0, 'r'),
      ),
    ).toBeUndefined();
    // An answered turn in the window breaks the streak.
    expect(
      detectStuck(
        [asked('subject'), { outcome: 'ANSWERED', slotsFilled: 1 }],
        now('subject', 1),
      ),
    ).toBeUndefined();
  });

  it('fires on a customer repeating the same message to unhelpful replies', () => {
    const fallback = (fp: string): PriorTurnSignal => ({
      outcome: 'FALLBACK',
      slotsFilled: 1,
      textFingerprint: fp,
    });
    expect(
      detectStuck([fallback('x'), fallback('x')], {
        outcome: 'FALLBACK',
        slotsFilled: 1,
        textFingerprint: 'x',
      }),
    ).toBe('SAME_MESSAGE_REPEATED');
    // Similar but different messages are not a repeat.
    expect(
      detectStuck([fallback('x'), fallback('y')], {
        outcome: 'FALLBACK',
        slotsFilled: 1,
        textFingerprint: 'x',
      }),
    ).toBeUndefined();
  });

  it('is configurable and ignores turns that answer or hand over', () => {
    expect(
      detectStuck([asked('subject')], now('subject'), { repeatLimit: 1 }),
    ).toBe('SAME_QUESTION_REPEATED');
    expect(
      detectStuck([asked('s'), asked('s')], {
        outcome: 'ANSWERED',
        slotsFilled: 0,
        textFingerprint: 'a',
      }),
    ).toBeUndefined();
    expect(DEFAULT_STUCK_POLICY.repeatLimit).toBe(2);
  });

  it('fingerprints normalized text stably', () => {
    expect(textFingerprint('salom')).toBe(textFingerprint('salom'));
    expect(textFingerprint('salom')).not.toBe(textFingerprint('salon'));
    expect(textFingerprint('x')).toHaveLength(16);
  });

  it('hands over with a typed reason in a turn, and not while progressing', async () => {
    const stuckInput = {
      progress: {
        priorTurns: [asked('subject'), asked('subject')],
      },
    };
    const stuck = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'greeting')]),
      text: 'Hello',
      input: { conversationLocale: 'en', ...stuckInput },
    });
    expect(stuck.result).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'STUCK',
      stuckReason: 'SAME_QUESTION_REPEATED',
      safety: { gate: 'PROGRESS', escalation: { operatorNotified: false } },
    });
    const moving = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'greeting')]),
      text: 'Hello',
      input: {
        conversationLocale: 'en',
        progress: { priorTurns: [asked('subject'), { outcome: 'ANSWERED' }] },
      },
    });
    expect(moving.result.outcome).toBe('ASKED_SLOT');
  });
});

describe('lead scoring', () => {
  const scoring = EDUCATION_PACK.leadScoring!;
  const base = {
    slots: {},
    hasPhone: false,
    offerShown: false,
    quoteShown: false,
  };

  it('is valid pack data', () => {
    expect(() => DomainPackSchema.parse(EDUCATION_PACK)).not.toThrow();
    expect(() =>
      DomainPackSchema.parse({
        ...EDUCATION_PACK,
        leadScoring: { ...scoring, hot: 2, warm: 5 },
      }),
    ).toThrow();
  });

  it('scores COLD with no reasons for an empty conversation', () => {
    expect(scoreLead(scoring, base)).toEqual({
      level: 'COLD',
      points: 0,
      reasonCodes: [],
    });
  });

  it('adds up rules and always returns reason codes', () => {
    const warm = scoreLead(scoring, {
      ...base,
      slots: { subject: 'IELTS', format: 'online' },
      offerShown: true,
    });
    expect(warm).toMatchObject({ level: 'WARM', points: 4 });
    expect(warm.reasonCodes).toEqual([
      'CONCRETE_ITEM',
      'OFFER_SHOWN',
      'FORMAT_SPECIFIED',
    ]);
    const hot = scoreLead(scoring, {
      ...base,
      slots: { subject: 'IELTS' },
      intent: 'booking_interest',
      hasPhone: true,
      quoteShown: true,
    });
    expect(hot.level).toBe('HOT');
    expect(hot.reasonCodes).toEqual([
      'PHONE_PROVIDED',
      'ASKED_TO_BOOK',
      'CONCRETE_ITEM',
      'QUOTE_SHOWN',
    ]);
  });

  it('does not invent a phone or quote', () => {
    expect(
      scoreLead(scoring, { ...base, slots: { subject: 'IELTS' } }).reasonCodes,
    ).not.toContain('PHONE_PROVIDED');
  });
});

describe('HIGH_VALUE trigger', () => {
  const IELTS = 'mock-education:edu-ielts-001';
  const WEEKDAY = 'mock-education:offer:ielts-group-weekday';
  const quoteTurn = (highValue?: {
    currency: string;
    minAmount: string;
  }): ReturnType<typeof runTurn> =>
    runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }, 'price'),
        {
          kind: 'tools',
          toolCalls: [{ name: 'list_offers', input: { itemId: IELTS } }],
        },
        {
          kind: 'tools',
          toolCalls: [{ name: 'get_quote', input: { offerId: WEEKDAY } }],
        },
        { kind: 'tools', text: '{{F1}} narxi: {{F10}}.' },
      ]),
      text: 'IELTS kursi narxi qancha?',
      pack: DomainPackSchema.parse({
        ...EDUCATION_PACK,
        ...(highValue ? { highValue } : {}),
      }),
    });

  it('keeps the quote from the customer when it reaches the pack threshold', async () => {
    const { result } = await quoteTurn({ currency: 'USD', minAmount: '100' });
    expect(result).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'HIGH_VALUE',
      safety: { escalation: { reason: 'HIGH_VALUE', operatorNotified: false } },
    });
    expect(result.reply).not.toMatch(/150/u);
    // The operator still gets the verified quote.
    expect(
      result.facts.some(
        (f) => f.value.kind === 'price' && f.value.confirmedQuote,
      ),
    ).toBe(true);
  });

  it('answers when below the threshold, in another currency, or with no threshold', async () => {
    for (const config of [
      { currency: 'USD', minAmount: '150.01' },
      { currency: 'UZS', minAmount: '1' },
      undefined,
    ]) {
      const { result } = await quoteTurn(config);
      expect(result.outcome).toBe('ANSWERED');
      expect(result.reply).toMatch(/150/u);
    }
    expect(
      (await quoteTurn({ currency: 'USD', minAmount: '150' })).result.handover,
    ).toBe('HIGH_VALUE');
  });

  it('compares decimals exactly', () => {
    expect(decimalAtLeast('150.00', '150')).toBe(true);
    expect(decimalAtLeast('149.999999', '150')).toBe(false);
    expect(decimalAtLeast('1000', '999.5')).toBe(true);
    expect(decimalAtLeast('0.1', '0.10')).toBe(true);
  });
});
