import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../core/agent/language.js';
import {
  assessLanguage,
  decideBeforeFacts,
} from '../core/agent/language-policy.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { extraction, LOCALES, runTurn } from './testing/agent-harness.js';

/**
 * Regression tests for the detector's evidence rules. The expectations are
 * about the rules (a letter is never enough; contradictions cap confidence),
 * not about measured accuracy on real customer text, which does not exist.
 */
describe('language detection evidence rules', () => {
  it.each([
    ['xqzv wkrt'],
    ['q'],
    ['qqq'],
    ['qxz'],
    ['zxvb wkrt hjmn'],
    ['reply in russian xqzv wkrt'],
    ["o' g' o'"],
  ])('does not classify the meaningless string %j with confidence', (text) => {
    const a = assessLanguage(text, LOCALES);
    expect(a.confidenceClass).not.toBe('HIGH');
    expect(detectLanguage(text).confidence).toBeLessThanOrEqual(0.25);
  });

  it.each([['ok'], ['a'], ['?'], ['Ali'], ['IELTS'], ['Python 3']])(
    'treats the very short message %j as ambiguous',
    (text) => {
      expect(assessLanguage(text, LOCALES).confidenceClass).not.toBe('HIGH');
    },
  );

  it.each([
    ['Salom, qachon boshlanadi?', 'uz-Latn'],
    ['Narxi qancha?', 'uz-Latn'],
    ["Assalomu alaykum, menga o'zbekcha kerak", 'uz-Latn'],
    ['Салом, нархи қанча?', 'uz-Cyrl'],
    ['Ассалому алайкум, қачон бошланади, менга керак', 'uz-Cyrl'],
    ['Здравствуйте, сколько стоит?', 'ru'],
    ['Hello, how much is it?', 'en'],
    ['salom narxi qancah', 'uz-Latn'],
  ])('still recognises genuine text %j as %s', (text, locale) => {
    expect(assessLanguage(text, LOCALES)).toMatchObject({
      localeId: locale,
      confidenceClass: 'HIGH',
    });
  });

  it('keeps a genuine Uzbek Cyrillic sentence without listed words out of the high range', () => {
    // Only marker letters: honest LOW, so the safe clarification path applies.
    const a = assessLanguage('Мен ўқимоқчиман', LOCALES);
    expect(a.confidenceClass).not.toBe('HIGH');
  });

  it.each([
    ['Menga kurs kerak, сколько стоит?'],
    ['Салом, сколько стоит?'],
    ['Salom, how much is it?'],
    ['Здравствуйте, qancha turadi, salom'],
  ])('never rates the mixed-language message %j as high confidence', (text) => {
    expect(assessLanguage(text, LOCALES).confidenceClass).not.toBe('HIGH');
  });

  it('a word of another language lowers the confidence it would otherwise have', () => {
    const pure = detectLanguage('Salom, narxi qancha');
    const mixed = detectLanguage('Salom, narxi qancha, thanks please');
    expect(mixed.confidence).toBeLessThan(pure.confidence);
  });
});

describe('language gate with unreadable text', () => {
  const slots = { subject: { value: 'IELTS', source: 'customer' as const } };

  it('does not look up facts for meaningless Latin text without model corroboration', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({}, 'search', 'other', 'other'),
    ]);
    const { result } = await runTurn({
      provider,
      text: 'xqzv wkrt',
      input: { slots },
    });
    expect(result.outcome).toBe('CLARIFICATION_REQUIRED');
    expect(result.tools).toEqual([]);
    expect(result.facts).toEqual([]);
  });

  it('a request for a reply language does not rescue unreadable text', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({}, 'search', 'other', 'other'),
    ]);
    const { result } = await runTurn({
      provider,
      text: 'rus tilida yozing xqzv wkrt',
      input: { slots },
    });
    expect(result.outcome).toBe('CLARIFICATION_REQUIRED');
    expect(result.locale).toBe('ru');
    expect(result.facts).toEqual([]);
  });

  it('a lone "q" in a message is not corroboration for the gate', () => {
    const a = assessLanguage('q', LOCALES);
    expect(
      decideBeforeFacts(
        a,
        { established: undefined, unclearStreak: 0 },
        'uz-Latn',
        LOCALES,
        undefined,
      ).action,
    ).toBe('CLARIFY');
  });
});
