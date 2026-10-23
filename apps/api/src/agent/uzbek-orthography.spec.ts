import {
  normalizeForMatching,
  updatedLatnToLegacy,
  uzbekOrthography,
  uzCyrlToLatn,
  uzLatnToCyrl,
} from '@agentcore/shared';
import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../core/agent/language.js';
import {
  assessLanguage,
  requestedLocale,
} from '../core/agent/language-policy.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import {
  educationConnector,
  extraction,
  LOCALES,
  runTurn,
} from './testing/agent-harness.js';

/**
 * Orthography rules. The updated-Latin letters (Ğ Ö Ş Ç) are as supplied for
 * this project; nothing here claims native-speaker validation or measured
 * accuracy on real text.
 */
describe('updated Latin <-> legacy Latin folding', () => {
  it.each([
    ['özbek', "o'zbek"],
    ['Özbek', "O'zbek"],
    ['ğoya', "g'oya"],
    ['şahar', 'shahar'],
    ['Şahar', 'Shahar'],
    ['ŞAHAR', 'SHAHAR'],
    ['çoy', 'choy'],
    ['ÇOY', 'CHOY'],
    ['ÖZBEK TILI', "O'ZBEK TILI"],
    ["o'zbek shahar choy", "o'zbek shahar choy"],
    ['Salom', 'Salom'],
  ])('folds %j to %j', (input, expected) => {
    expect(updatedLatnToLegacy(input)).toBe(expected);
  });

  it('is idempotent, and does not double-transliterate', () => {
    const samples = [
      'Özbekçe şahar ğoya',
      "O'zbekcha shahar",
      'Ўзбекча шаҳар',
      'Oʻzbekcha, Toshkent',
      "ma'lumot san'at",
    ];
    for (const sample of samples) {
      const once = updatedLatnToLegacy(sample);
      expect(updatedLatnToLegacy(once)).toBe(once);
      const key = normalizeForMatching(sample);
      expect(normalizeForMatching(key)).toBe(key);
      expect(uzCyrlToLatn(uzCyrlToLatn(sample))).toBe(uzCyrlToLatn(sample));
    }
  });

  it('shares one matching key across legacy, updated and Cyrillic spellings', () => {
    const groups = [
      [
        "O'zbekcha",
        'Oʻzbekcha',
        'O‘zbekcha',
        'O’zbekcha',
        'Özbekcha',
        'Ўзбекча',
      ],
      ['Shahar', 'Şahar', 'ŞAHAR', 'шаҳар'],
      ['choy', 'çoy', 'чой'],
      ['Toshkent', 'Toşkent', 'Тошкент'],
    ];
    for (const group of groups) {
      const keys = new Set(group.map((value) => normalizeForMatching(value)));
      expect([...keys], group.join(' | ')).toHaveLength(1);
    }
  });

  it('does not conflate distinct words (no unsafe substitution)', () => {
    expect(normalizeForMatching('mas')).not.toBe(normalizeForMatching('maş'));
    // "s" + "h" typed separately stays what it is: only the ş letter folds.
    expect(updatedLatnToLegacy('as-hob')).toBe('as-hob');
    expect(normalizeForMatching('tosh')).toBe(normalizeForMatching('toş'));
  });

  it('round-trips Latin through Cyrillic without changing legacy spelling', () => {
    expect(uzCyrlToLatn(uzLatnToCyrl("o'zbekcha shahar"))).toBe(
      "o'zbekcha shahar",
    );
  });
});

describe('orthography is described separately from language', () => {
  it.each([
    ["Oʻzbek tili, g'oya", 'latin-legacy'],
    ['Özbek tili, ğoya', 'latin-updated'],
    ["Özbek tili, g'oya", 'latin-mixed'],
    ['Salom, narxi qancha', 'latin-neutral'],
    ['Салом, нархи қанча', 'cyrillic'],
    ['12345 ?!', 'none'],
  ])('%j is %s', (text, style) => {
    expect(uzbekOrthography(text)).toBe(style);
    expect(detectLanguage(text).orthography).toBe(style);
  });

  it('reports the style without letting it prove the language', () => {
    const a = assessLanguage('ğ ö ş ç', LOCALES);
    expect(a.orthography).toBe('latin-updated');
    expect(a.confidenceClass).not.toBe('HIGH');
  });
});

describe('detector across orthographies', () => {
  it.each([
    ["Assalomu alaykum, menga o'zbek tili kursi kerak", 'latin-legacy'],
    ['Assalomu alaykum, menga özbek tili kursi kerak', 'latin-updated'],
    ['Ассалому алайкум, менга ўзбек тили керак', 'cyrillic'],
    ['SALOM, NARXI QANCHA?', 'latin-neutral'],
    ['ASSALOMU ALAYKUM, MENGA ÖZBEK TILI KERAK', 'latin-updated'],
    ['САЛОМ, НАРХИ ҚАНЧА', 'cyrillic'],
    ['salom, narxi qancha', 'latin-neutral'],
  ])('recognises %j', (text, style) => {
    const a = assessLanguage(text, LOCALES);
    expect(a.localeId).toBe(
      text.match(/[А-Яа-яЎўҚқҒғҲҳ]/u) ? 'uz-Cyrl' : 'uz-Latn',
    );
    expect(a.confidenceClass).toBe('HIGH');
    expect(a.orthography).toBe(style);
  });

  it('still recognises Russian and English', () => {
    expect(
      assessLanguage('Здравствуйте, сколько стоит?', LOCALES).localeId,
    ).toBe('ru');
    expect(assessLanguage('Hello, how much is it?', LOCALES).localeId).toBe(
      'en',
    );
  });

  it.each([
    ['ğ'],
    ['ö'],
    ['ş'],
    ['ç'],
    ['q'],
    ['Ğ'],
    ['çşğö'],
    ['ğğğ ççç'],
    ['xqzv wkrt'],
    ['güzel şehir'],
    ['Özbek'],
    ['Çay'],
  ])('a letter or two is not evidence: %j', (text) => {
    expect(assessLanguage(text, LOCALES).confidenceClass).not.toBe('HIGH');
  });

  it('does not treat a mixed Uzbek/Russian message as one clear language', () => {
    expect(
      assessLanguage('Salom, menga kurs kerak, сколько стоит?', LOCALES)
        .confidenceClass,
    ).not.toBe('HIGH');
    expect(
      assessLanguage('Салом, сколько стоит курс?', LOCALES).confidenceClass,
    ).not.toBe('HIGH');
  });
});

describe('reply-language request versus understanding', () => {
  it('reads requests in updated spelling', () => {
    const all = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const;
    expect(requestedLocale('özbekcha yozing', LOCALES, all)).toBe('uz-Latn');
    expect(requestedLocale('Please reply in Russian', LOCALES, all)).toBe('ru');
  });

  it('a request does not make unreadable updated-Latin text understood', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({}, 'search', 'other', 'other'),
    ]);
    const { result } = await runTurn({
      provider,
      text: 'rus tilida yozing çşğö ğç',
      input: { slots: { subject: { value: 'IELTS', source: 'customer' } } },
    });
    expect(result.outcome).toBe('CLARIFICATION_REQUIRED');
    expect(result.facts).toEqual([]);
  });
});

describe('search across orthographic variants', () => {
  it('keeps the customer text and retries the query in canonical spelling', async () => {
    const base = educationConnector();
    const titles: Array<string | undefined> = [];
    const connector = {
      connectorKey: base.connectorKey,
      context: base.context,
      sourceSystem: base.sourceSystem,
      capabilities: base.capabilities,
      searchItems: async (query: { title?: string }): Promise<never[]> => {
        titles.push(query.title);
        return [];
      },
    };
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'Özbek tili' }, 'search', 'uz', 'Latn'),
    ]);
    const { result } = await runTurn({
      provider,
      text: 'Özbek tili kursi kerak, narxi qancha',
      connector: connector as never,
    });
    expect(result.slots.subject?.value).toBe('Özbek tili');
    expect(titles[0]).toBe('Özbek tili');
    expect(titles).toContain("O'zbek tili");
    expect(result.outcome).toBe('NO_RESULTS');
  });
});
