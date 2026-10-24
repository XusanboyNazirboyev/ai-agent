import { describe, expect, it } from 'vitest';
import {
  confirmationOf,
  planAction,
  proposalDigest,
  renderProposal,
  type ActionTurnContext,
} from '../core/actions/actions.js';
import { displayPolicyFor } from '../core/agent/display-gate.js';
import { FactStore } from '../core/agent/facts.js';
import { checkDraft } from '../core/agent/guardrails.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import {
  INITIAL_LOCALE_PACKS,
  EN,
  RU,
  UZ_LATN,
} from '../locales/locale-packs.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { extraction, runTurn } from './testing/agent-harness.js';

const spec = EDUCATION_PACK.actions[0];
const consent = {
  'uz-Latn': 'Raqamingiz va tanlovingiz markazga yuboriladi.',
  'uz-Cyrl': 'Рақамингиз ва танловингиз марказга юборилади.',
  ru: 'Ваш номер и выбор будут переданы центру.',
  en: 'Your number and choices will be sent to the centre.',
};
const scope = {
  tenantId: 't-1',
  conversationId: 'c-1',
  packRef: 'education@1',
};
const context = (over: Partial<ActionTurnContext> = {}): ActionTurnContext => ({
  available: [{ spec, consent }],
  contact: { phone: '+998901234567' },
  scope,
  ...over,
});
const slot = (
  value: string,
): { value: string; source: 'customer'; confidence: number } => ({
  value,
  source: 'customer' as const,
  confidence: 1,
});

describe('action planning (pure)', () => {
  it('asks the first missing required field and sends only declared fields', () => {
    expect(planAction(spec, {}, {})).toMatchObject({
      kind: 'ASK',
      field: { name: 'slots.subject' },
    });
    expect(planAction(spec, { subject: slot('IELTS') }, {})).toMatchObject({
      kind: 'ASK',
      field: { name: 'slots.preferredTime' },
    });
    expect(
      planAction(
        spec,
        { subject: slot('IELTS'), preferredTime: slot('morning') },
        {},
      ),
    ).toMatchObject({
      kind: 'ASK',
      field: { name: 'contact.phone' },
    });
    const ready = planAction(
      spec,
      {
        subject: slot('IELTS'),
        preferredTime: slot('morning'),
        budget: slot('1000'),
        goal: slot('study abroad'),
      },
      { phone: '+998901234567', name: 'Ali' },
    );
    expect(ready).toEqual({
      kind: 'READY',
      payload: {
        'slots.subject': 'IELTS',
        'slots.preferredTime': 'morning',
        'contact.phone': '+998901234567',
      },
    });
  });

  it('treats an invalid phone as missing', () => {
    const plan = planAction(
      spec,
      { subject: slot('IELTS'), preferredTime: slot('morning') },
      { phone: '12-ab' },
    );
    expect(plan).toMatchObject({
      kind: 'ASK',
      field: { name: 'contact.phone' },
    });
  });

  it('binds the digest to tenant, conversation, action and every value', () => {
    const payload = {
      'slots.subject': 'IELTS',
      'contact.phone': '+998901234567',
    };
    const base = proposalDigest(scope, spec.key, payload);
    expect(proposalDigest(scope, spec.key, { ...payload })).toBe(base);
    expect(
      proposalDigest(scope, spec.key, { ...payload, 'slots.subject': 'SAT' }),
    ).not.toBe(base);
    expect(
      proposalDigest({ ...scope, tenantId: 't-2' }, spec.key, payload),
    ).not.toBe(base);
    expect(
      proposalDigest({ ...scope, conversationId: 'c-2' }, spec.key, payload),
    ).not.toBe(base);
  });

  it('accepts only whole-message confirmation phrases, in any supported language', () => {
    for (const text of ['ha', 'Ha!', 'yes', 'Да', 'ҳа', 'tasdiqlayman'])
      expect(confirmationOf(text, INITIAL_LOCALE_PACKS), text).toBe('CONFIRM');
    for (const text of ["yo'q", 'no', 'нет', 'отмена'])
      expect(confirmationOf(text, INITIAL_LOCALE_PACKS), text).toBe('DECLINE');
    for (const text of [
      'ha, lekin ertaga',
      'yes please change the time',
      'maybe',
      '',
      'да нет',
    ])
      expect(confirmationOf(text, INITIAL_LOCALE_PACKS), text).toBeUndefined();
  });

  it('renders every value that will be sent, the consent and how to confirm', () => {
    const text = renderProposal(
      { spec, consent },
      { 'slots.subject': 'IELTS', 'contact.phone': '+998901234567' },
      EN,
    );
    expect(text).toContain('course enquiry');
    expect(text).toContain('Subject: IELTS');
    expect(text).toContain('Phone: +998901234567');
    expect(text).toContain(consent.en);
    expect(text).toContain('“yes”');
  });

  it('never lets a model draft claim a completed action', () => {
    for (const [locale, draft] of [
      [EN, 'Great news, your request has been recorded in our CRM.'],
      [RU, 'Ваша заявка создана.'],
      [UZ_LATN, "Siz ro'yxatdan o'tdingiz!"],
    ] as const) {
      const verdict = checkDraft(draft, {
        facts: new FactStore(),
        locale,
        customerTexts: [],
        timeZone: 'Asia/Tashkent',
        now: new Date(),
        evidence: {
          tenantId: 't1',
          conversationId: 'c1',
          policy: displayPolicyFor({ liveQuote: true, availability: true }),
        },
      });
      expect(verdict.violations, draft).toContain('ACTION_CLAIM');
    }
  });
});

describe('action flow in the agent turn', () => {
  const booking = (slots: Record<string, string | null>): ScriptedLlmProvider =>
    new ScriptedLlmProvider([extraction(slots, 'booking_interest')]);

  it('without an enabled action, booking interest is an ordinary turn', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }, 'booking_interest'),
        { kind: 'tools', text: 'Mana {{F1}}.' },
      ]),
      text: 'IELTS ga yozilmoqchiman',
    });
    expect(result.action).toBeUndefined();
    expect(result.outcome).not.toBe('ACTION_PROPOSED');
  });

  it('asks a missing field with the pack question and marks the action as collecting', async () => {
    const { result } = await runTurn({
      provider: booking({ subject: 'IELTS' }),
      text: 'IELTS ga yozilmoqchiman',
      input: { action: context() },
    });
    expect(result.outcome).toBe('ASKED_SLOT');
    expect(result.askedSlot).toBe('action:course_enquiry:slots.preferredTime');
    expect(result.reply).toBe(
      EDUCATION_PACK.slots.find((s) => s.key === 'preferredTime')!.questions[
        'uz-Latn'
      ],
    );
    expect(result.action).toBeUndefined();
  });

  it('continues collecting on the next message even without the trigger intent', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS', preferredTime: 'morning' }, 'other'),
      ]),
      text: 'ertalab',
      input: { action: context({ collecting: 'course_enquiry' }) },
    });
    expect(result.outcome).toBe('ACTION_PROPOSED');
  });

  it('asks for the phone with the existing template when it is missing', async () => {
    const { result } = await runTurn({
      provider: booking({ subject: 'IELTS', preferredTime: 'morning' }),
      text: 'IELTS, ertalab',
      input: { action: context({ contact: {} }) },
    });
    expect(result.askedSlot).toBe('action:course_enquiry:contact.phone');
    expect(result.reply).toBe(UZ_LATN.templates.phoneRequest);
  });

  it('proposes with a code-rendered summary; the model writes nothing', async () => {
    const provider = booking({
      subject: 'IELTS',
      preferredTime: 'morning',
      budget: '900',
    });
    const { result } = await runTurn({
      provider,
      text: 'IELTS ertalab, yozilaman',
      input: { action: context() },
    });
    expect(result.outcome).toBe('ACTION_PROPOSED');
    expect(provider.calls.filter((c) => c.type !== 'structured')).toHaveLength(
      0,
    );
    expect(result.reply).toContain('IELTS');
    expect(result.reply).toContain('+998901234567');
    expect(result.reply).toContain(consent['uz-Latn']);
    expect(result.reply).not.toContain('900');
    expect(result.action).toEqual({
      kind: 'PROPOSE',
      actionKey: 'course_enquiry',
      payload: {
        'slots.subject': 'IELTS',
        'slots.preferredTime': 'morning',
        'contact.phone': '+998901234567',
      },
      digest: proposalDigest(scope, 'course_enquiry', {
        'slots.subject': 'IELTS',
        'slots.preferredTime': 'morning',
        'contact.phone': '+998901234567',
      }),
      expiresAfterMinutes: 30,
    });
  });

  it('confirms or declines an exact reply before any model call', async () => {
    const pending = {
      id: 'p-1',
      actionKey: 'course_enquiry',
      digest: 'd'.repeat(64),
    };
    for (const [text, outcome, kind] of [
      ['ha', 'ACTION_CONFIRMED', 'CONFIRM'],
      ["yo'q", 'ACTION_DECLINED', 'DECLINE'],
    ] as const) {
      const provider = new ScriptedLlmProvider([]);
      const { result, usage } = await runTurn({
        provider,
        text,
        input: { action: context({ pending }) },
      });
      expect(result.outcome).toBe(outcome);
      expect(result.action).toMatchObject({ kind, proposalId: 'p-1' });
      expect(provider.calls).toHaveLength(0);
      expect(usage).toHaveLength(0);
    }
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([]),
      text: 'ha',
      input: { action: context({ pending }) },
    });
    expect(result.reply).toBe(UZ_LATN.templates.actions.received);
  });

  it('any other message retires the open proposal; a re-proposal supersedes it explicitly', async () => {
    const pending = {
      id: 'p-1',
      actionKey: 'course_enquiry',
      digest: 'd'.repeat(64),
    };
    const other = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }, 'price'),
        { kind: 'tools', text: 'Narxi {{F1}}.' },
      ]),
      text: 'narxi qancha?',
      input: { action: context({ pending }) },
    });
    expect(other.result.action).toEqual({
      kind: 'SUPERSEDE',
      proposalId: 'p-1',
    });
    const changed = await runTurn({
      provider: booking({ subject: 'IELTS', preferredTime: 'evening' }),
      text: 'yo‘q, kechqurun bo‘lsin, yozilaman',
      input: { action: context({ pending }) },
    });
    expect(changed.result.action).toMatchObject({
      kind: 'PROPOSE',
      supersedes: 'p-1',
      payload: { 'slots.preferredTime': 'evening' },
    });
  });
});
