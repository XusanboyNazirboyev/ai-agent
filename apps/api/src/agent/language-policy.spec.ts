import { describe, expect, it } from 'vitest';
import {
  assessLanguage,
  DEFAULT_LANGUAGE_POLICY,
  decideBeforeFacts,
  decideBeforeModel,
  languageHistory,
  requestedLocale,
  type LanguageHistory,
} from '../core/agent/language-policy.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { LocaleRegistry } from '../core/locales/locale-pack.js';
import { INITIAL_LOCALE_PACKS, UZ_LATN } from '../locales/locale-packs.js';
import { extraction, LOCALES, runTurn } from './testing/agent-harness.js';

const NONE: LanguageHistory = { established: undefined, unclearStreak: 0 };
const ARABIC = 'مرحبا كم سعر الدورة';
const CHINESE = '你好课程多少钱';

describe('language assessment', () => {
  it.each([
    ['uz-Latn', 'Salom, menga kurs kerak'],
    ['uz-Cyrl', 'Салом, менга курс керак'],
    ['ru', 'Здравствуйте, сколько стоит курс?'],
    ['en', 'Hello, how much is the course?'],
  ])('identifies %s with high confidence', (localeId, text) => {
    const a = assessLanguage(text, LOCALES);
    expect(a).toMatchObject({
      localeId,
      confidenceClass: 'HIGH',
      ambiguity: 'NONE',
      localeStatus: 'beta',
      method: 'lexical-heuristic',
      calibrated: false,
    });
  });

  it.each([
    ["Assalomu alaykum, o'zbekcha kurs bormi"],
    ['Assalomu alaykum, oʻzbekcha kurs bormi'],
    ['Assalomu alaykum, o‘zbekcha kurs bormi'],
    ['Assalomu alaykum, o`zbekcha kurs bormi'],
  ])('is stable across apostrophe variants: %s', (text) => {
    expect(assessLanguage(text, LOCALES)).toMatchObject({
      localeId: 'uz-Latn',
      confidenceClass: 'HIGH',
    });
  });

  it('tolerates a typo next to recognised words', () => {
    expect(assessLanguage('salom narxi qancah', LOCALES)).toMatchObject({
      localeId: 'uz-Latn',
      confidenceClass: 'HIGH',
    });
  });

  it('never calls a Latin/Cyrillic mixture high confidence', () => {
    const a = assessLanguage('Menga kurs kerak, сколько стоит?', LOCALES);
    expect(a.ambiguity).toBe('MIXED_SCRIPT');
    expect(a.confidenceClass).not.toBe('HIGH');
  });

  it.each([['ok'], ['Ali'], ['IELTS'], ['Python']])(
    'treats the short message %s as unrecognised, not as a language',
    (text) => {
      const a = assessLanguage(text, LOCALES);
      expect(a.confidenceClass).not.toBe('HIGH');
      expect(a.ambiguity).toBe('UNRECOGNIZED');
    },
  );

  it.each([[ARABIC], [CHINESE]])('flags an unsupported script: %s', (text) => {
    expect(assessLanguage(text, LOCALES)).toMatchObject({
      ambiguity: 'UNSUPPORTED_SCRIPT',
      localeId: undefined,
      confidenceClass: 'NONE',
    });
  });

  it.each([[''], ['   '], ['👍'], ['123 456']])(
    'treats %j as carrying no language signal',
    (text) => {
      expect(assessLanguage(text, LOCALES)).toMatchObject({
        ambiguity: 'NO_LETTERS',
        localeId: undefined,
      });
    },
  );

  it('uses the configurable per-status thresholds', () => {
    const strict = {
      ...DEFAULT_LANGUAGE_POLICY,
      highConfidence: { stable: 0.4, beta: 0.95, planned: 1.01 },
    };
    expect(assessLanguage('salom', LOCALES, strict).confidenceClass).toBe(
      'MEDIUM',
    );
    expect(assessLanguage('salom', LOCALES).confidenceClass).toBe('HIGH');
  });

  it('keeps every shipped locale beta (never stable without review)', () => {
    expect(INITIAL_LOCALE_PACKS.every((p) => p.status === 'beta')).toBe(true);
    expect(
      () => new LocaleRegistry([{ ...UZ_LATN, status: 'stable' }]),
    ).toThrow(/native review/u);
  });
});

describe('language history', () => {
  const customer = (text: string): { role: 'customer'; text: string } => ({
    role: 'customer',
    text,
  });

  it('establishes a locale from a clear earlier message', () => {
    expect(
      languageHistory([customer('Salom, menga kurs kerak')], LOCALES),
    ).toEqual({ established: 'uz-Latn', unclearStreak: 0 });
  });

  it('counts consecutive unclear turns and resets on a clear one', () => {
    expect(
      languageHistory([customer(ARABIC), customer(CHINESE)], LOCALES)
        .unclearStreak,
    ).toBe(2);
    expect(
      languageHistory(
        [customer(ARABIC), customer('Hello, I need a course')],
        LOCALES,
      ),
    ).toEqual({ established: 'en', unclearStreak: 0 });
  });

  it('does not count short text inside an established conversation', () => {
    expect(
      languageHistory(
        [customer('Salom, menga kurs kerak'), customer('ok'), customer('Ali')],
        LOCALES,
      ).unclearStreak,
    ).toBe(0);
  });

  it('ignores agent messages', () => {
    expect(languageHistory([{ role: 'agent', text: ARABIC }], LOCALES)).toEqual(
      NONE,
    );
  });
});

describe('language decisions', () => {
  const mixed = assessLanguage('Menga kurs kerak, сколько стоит?', LOCALES);
  const ielts = assessLanguage('IELTS', LOCALES);
  const hello = assessLanguage('Salom, menga kurs kerak', LOCALES);

  it('hard-stops an unsupported script before any model call, then escalates', () => {
    const arabic = assessLanguage(ARABIC, LOCALES);
    expect(decideBeforeModel(arabic, NONE)).toEqual({
      action: 'CLARIFY',
      reasonCodes: ['UNSUPPORTED_SCRIPT'],
    });
    expect(
      decideBeforeModel(arabic, { established: undefined, unclearStreak: 1 }),
    ).toMatchObject({ action: 'ESCALATE' });
    expect(decideBeforeModel(hello, NONE)).toEqual({ action: 'PROCEED' });
    expect(decideBeforeModel(ielts, NONE)).toEqual({ action: 'PROCEED' });
  });

  it('proceeds to facts on a clear message or an established locale', () => {
    expect(
      decideBeforeFacts(hello, NONE, 'uz-Latn', LOCALES, undefined),
    ).toEqual({ action: 'PROCEED' });
    expect(
      decideBeforeFacts(
        ielts,
        { established: 'uz-Latn', unclearStreak: 0 },
        'uz-Latn',
        LOCALES,
        undefined,
      ),
    ).toEqual({ action: 'PROCEED' });
  });

  it('accepts the extraction model as corroboration only when the heuristic does not contradict it', () => {
    expect(
      decideBeforeFacts(ielts, NONE, 'uz-Latn', LOCALES, 'uz-Latn'),
    ).toEqual({ action: 'PROCEED' });
    // No corroboration, mixed script, or a contradicting model: clarify.
    expect(
      decideBeforeFacts(ielts, NONE, 'uz-Latn', LOCALES, undefined).action,
    ).toBe('CLARIFY');
    expect(
      decideBeforeFacts(mixed, NONE, 'uz-Latn', LOCALES, 'uz-Latn').action,
    ).toBe('CLARIFY');
    expect(decideBeforeFacts(hello, NONE, 'ru', LOCALES, 'ru').action).toBe(
      'CLARIFY',
    );
  });

  it('can require the customer’s own text for beta locales', () => {
    const strict = {
      ...DEFAULT_LANGUAGE_POLICY,
      modelCorroboration: { stable: true, beta: false, planned: false },
    };
    expect(
      decideBeforeFacts(ielts, NONE, 'uz-Latn', LOCALES, 'uz-Latn', strict)
        .action,
    ).toBe('CLARIFY');
  });

  it('escalates once the unclear streak reaches the configured limit', () => {
    expect(
      decideBeforeFacts(
        ielts,
        { established: undefined, unclearStreak: 1 },
        'uz-Latn',
        LOCALES,
        undefined,
      ).action,
    ).toBe('ESCALATE');
    const patient = { ...DEFAULT_LANGUAGE_POLICY, maxUnclearTurns: 3 };
    expect(
      decideBeforeFacts(
        ielts,
        { established: undefined, unclearStreak: 1 },
        'uz-Latn',
        LOCALES,
        undefined,
        patient,
      ).action,
    ).toBe('CLARIFY');
  });
});

describe('language gate in a turn', () => {
  const clarification = UZ_LATN.templates.languageClarification;

  it('asks for a supported language without spending any model call', async () => {
    const provider = new ScriptedLlmProvider([]);
    const { result, usage } = await runTurn({ provider, text: ARABIC });
    expect(result).toMatchObject({
      outcome: 'CLARIFICATION_REQUIRED',
      safety: {
        status: 'CLARIFICATION_REQUIRED',
        gate: 'LANGUAGE',
        reasonCodes: ['UNSUPPORTED_SCRIPT'],
      },
    });
    expect(result.reply).toBe(clarification);
    expect(provider.calls).toHaveLength(0);
    expect(usage).toHaveLength(0);
    expect(result.budget.spentNano).toBe(0);
  });

  it('escalates as LOW_LANG_CONFIDENCE on the repeated failure, without claiming a handover', async () => {
    const provider = new ScriptedLlmProvider([]);
    const { result } = await runTurn({
      provider,
      text: CHINESE,
      input: {
        history: [
          { role: 'customer', text: ARABIC },
          { role: 'agent', text: clarification },
        ],
      },
    });
    expect(result).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'LOW_LANG_CONFIDENCE',
      safety: {
        status: 'ESCALATION_REQUIRED',
        gate: 'LANGUAGE',
        escalation: { reason: 'LOW_LANG_CONFIDENCE', operatorNotified: false },
      },
    });
    expect(result.reply).toBe(UZ_LATN.templates.handover.LOW_LANG_CONFIDENCE);
    expect(provider.calls).toHaveLength(0);
  });

  it('asks before facts when a mixed-script first message cannot be trusted, keeping prior slots', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'price'),
    ]);
    const { result } = await runTurn({
      provider,
      text: 'IELTS kerak, сколько стоит?',
      input: { slots: { level: { value: 'beginner', source: 'customer' } } },
    });
    expect(result.outcome).toBe('CLARIFICATION_REQUIRED');
    expect(result.slots).toEqual({
      level: { value: 'beginner', source: 'customer' },
    });
    expect(result.tools).toEqual([]);
    expect(result.facts).toEqual([]);
  });

  it('resumes the conversation once a clear message follows the clarification', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search'),
      { kind: 'tools', text: 'Sizga {{F1}} kursi mos keladi.' },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'Salom, menga IELTS kursi kerak',
      input: {
        history: [
          { role: 'customer', text: 'IELTS kerak, сколько стоит?' },
          { role: 'agent', text: clarification },
        ],
      },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.slots.subject?.value).toBe('IELTS');
  });

  it('does not block a short follow-up inside an established conversation', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search'),
      { kind: 'tools', text: 'Sizga {{F1}} kursi mos keladi.' },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'IELTS',
      input: {
        conversationLocale: 'uz-Latn',
        history: [{ role: 'customer', text: 'Salom, menga kurs kerak' }],
      },
    });
    expect(result.outcome).toBe('ANSWERED');
  });

  it('treats a failed or foreign extraction language as no corroboration', async () => {
    const failed = await runTurn({
      provider: new ScriptedLlmProvider([
        { kind: 'structured', failure: 'malformed' },
      ]),
      text: 'IELTS',
      input: { slots: { subject: { value: 'IELTS', source: 'customer' } } },
    });
    expect(failed.result.outcome).toBe('CLARIFICATION_REQUIRED');
    const foreign = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }, 'search', 'other', 'other'),
      ]),
      text: 'IELTS',
      input: { slots: { subject: { value: 'IELTS', source: 'customer' } } },
    });
    expect(foreign.result.outcome).toBe('CLARIFICATION_REQUIRED');
  });
});

describe('explicit language requests', () => {
  const all = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const;
  it.each([
    ['Iltimos rus tilida yozing', 'ru'],
    ['Напишите на английском, пожалуйста', 'en'],
    ['Please reply in Russian', 'ru'],
    ['O‘zbekcha yozing', 'uz-Latn'],
    ['ўзбекча ёзинг', 'uz-Cyrl'],
    ['kirilchada yozing', 'uz-Cyrl'],
  ])('reads %j as a request for %s', (text, locale) => {
    expect(requestedLocale(text, LOCALES, all)).toBe(locale);
  });

  it.each([
    ['I want an English course'],
    ['Курс на русском языке есть?'],
    ['IELTS kerak'],
    ['write in english or write in russian'],
  ])('does not treat %j as a request (subject or ambiguous)', (text) => {
    expect(requestedLocale(text, LOCALES, all)).toBeUndefined();
  });

  it('ignores locales the tenant does not support', () => {
    expect(
      requestedLocale('reply in english', LOCALES, ['ru']),
    ).toBeUndefined();
  });

  it('pins the requested locale in the history until another request', () => {
    const asked = languageHistory(
      [
        { role: 'customer', text: 'Please reply in Russian' },
        { role: 'customer', text: 'Salom, menga kurs kerak' },
      ],
      LOCALES,
    );
    expect(asked.pinned).toBe('ru');
    const changed = languageHistory(
      [
        { role: 'customer', text: 'Please reply in Russian' },
        { role: 'customer', text: 'write in english' },
      ],
      LOCALES,
    );
    expect(changed.pinned).toBe('en');
  });

  it('keeps a pinned locale for later messages in a turn', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search', 'uz', 'Latn'),
      { kind: 'tools', text: 'Вам подойдёт курс {{F1}}.' },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'Salom, menga IELTS kursi kerak',
      input: {
        conversationLocale: 'uz-Latn',
        history: [
          { role: 'customer', text: 'Пожалуйста, напишите на русском' },
        ],
      },
    });
    expect(result.locale).toBe('ru');
    expect(result.outcome).toBe('ANSWERED');
  });
});
