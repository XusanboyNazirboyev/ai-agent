import {
  DomainPackSchema,
  normalizeForMatching,
  unifyApostrophes,
  uzCyrlToLatn,
  uzLatnToCyrl,
} from '@agentcore/shared';
import { describe, expect, it } from 'vitest';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import {
  EN,
  INITIAL_LOCALE_PACKS,
  RU,
  UZ_CYRL,
  UZ_LATN,
} from '../locales/locale-packs.js';
import { formatMoney, LocaleRegistry } from '../core/locales/locale-pack.js';
import { FactStore } from '../core/agent/facts.js';
import { displayPolicyFor } from '../core/agent/display-gate.js';
import { checkDraft } from '../core/agent/guardrails.js';
import { chooseLocale, detectLanguage } from '../core/agent/language.js';
import {
  detectEnumSlots,
  firstMissing,
  mergeSlots,
  normalizeSlot,
  searchQuery,
} from '../core/agent/slots.js';

describe('Uzbek transliteration', () => {
  it.each([
    ['Ўзбекистон', "O'zbekiston"],
    ['қанча', 'qancha'],
    ['ғишт', "g'isht"],
    ['еттита', 'yettita'],
    ['маълумот', "ma'lumot"],
    ['шаҳар', 'shahar'],
    ['йўл', "yo'l"],
    ['ёмон', 'yomon'],
    ['санъат', "san'at"],
    ['сунъий', "sun'iy"],
  ])('%s <-> %s', (cyrillic, latin) => {
    expect(uzCyrlToLatn(cyrillic)).toBe(latin);
    expect(uzLatnToCyrl(latin)).toBe(cyrillic);
  });

  it('handles word-initial e/э and apostrophe variants', () => {
    expect(uzLatnToCyrl('ertaga')).toBe('эртага');
    expect(uzLatnToCyrl('yo‘naltiraman')).toBe('йўналтираман');
    expect(uzLatnToCyrl("'salom'")).toBe("'салом'");
    expect(unifyApostrophes('oʻ o‘ o’ o`')).toBe("o' o' o' o'");
    expect(normalizeForMatching('ОНЛАЙН')).toBe(normalizeForMatching('onlayn'));
    expect(normalizeForMatching('O‘ZBEK')).toBe("o'zbek");
  });
});

describe('language and script detection', () => {
  it.each([
    ['Salom, IELTS kursi kerak edi', 'uz', 'Latn'],
    ['O‘zbek tili darslari bormi?', 'uz', 'Latn'],
    ['Салом, IELTS курси керак эди', 'uz', 'Cyrl'],
    ['Ассалому алайкум, нархи қанча?', 'uz', 'Cyrl'],
    ['Здравствуйте, сколько стоит курс?', 'ru', 'Cyrl'],
    ['Hi, I need an IELTS course', 'en', 'Latn'],
  ])('%s', (text, language, script) => {
    const detected = detectLanguage(text);
    expect(detected).toMatchObject({ language, script });
    expect(detected.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('gives low confidence to short or ambiguous messages', () => {
    for (const text of ['ok', 'IELTS', '123', '']) {
      expect(detectLanguage(text).confidence).toBeLessThan(0.6);
    }
  });

  it('keeps the current locale unless the customer clearly switches', () => {
    const registry = new LocaleRegistry(INITIAL_LOCALE_PACKS);
    const options = {
      current: 'uz-Cyrl' as const,
      supported: ['uz-Latn', 'uz-Cyrl', 'ru'] as const,
      fallback: 'uz-Latn' as const,
      registry,
    };
    expect(chooseLocale(detectLanguage('ok'), options)).toBe('uz-Cyrl');
    expect(
      chooseLocale(
        detectLanguage('Здравствуйте, сколько стоит курс?'),
        options,
      ),
    ).toBe('ru');
    expect(
      chooseLocale(detectLanguage('Hi, I need an IELTS course'), options),
    ).toBe('uz-Cyrl');
  });
});

describe('slot engine', () => {
  const format = EDUCATION_PACK.slots.find((slot) => slot.key === 'format')!;
  const age = EDUCATION_PACK.slots.find((slot) => slot.key === 'studentAge')!;

  it('normalizes enum synonyms in any script and rejects the rest', () => {
    expect(normalizeSlot(format, 'ОНЛАЙН')).toEqual({
      kind: 'value',
      value: 'online',
    });
    expect(normalizeSlot(format, 'очно')).toEqual({
      kind: 'value',
      value: 'offline',
    });
    expect(normalizeSlot(format, 'by pigeon')).toEqual({ kind: 'invalid' });
    expect(normalizeSlot(age, '15')).toEqual({ kind: 'value', value: 15 });
    expect(normalizeSlot(age, '150')).toEqual({ kind: 'invalid' });
    expect(normalizeSlot(age, 'fifteen')).toEqual({ kind: 'invalid' });
  });

  it('finds the first missing slot per stage and builds the canonical query', () => {
    const { state } = mergeSlots(
      EDUCATION_PACK,
      {},
      { subject: 'IELTS', format: 'onlayn' },
    );
    expect(firstMissing(EDUCATION_PACK, {}, 'search')?.key).toBe('subject');
    expect(firstMissing(EDUCATION_PACK, state, 'search')).toBeUndefined();
    expect(
      firstMissing(EDUCATION_PACK, { subject: state.subject }, 'quote')?.key,
    ).toBe('format');
    expect(searchQuery(EDUCATION_PACK, state)).toEqual({
      itemType: 'course',
      title: 'IELTS',
      attributes: { format: 'online' },
      limit: 3,
    });
    expect(
      searchQuery(EDUCATION_PACK, state, { requiredOnly: true }),
    ).not.toHaveProperty('attributes');
  });

  it('detects whole-word enum synonyms only', () => {
    expect(detectEnumSlots(EDUCATION_PACK, 'Kechqurun onlayn darslar')).toEqual(
      {
        format: 'online',
        preferredTime: 'evening',
      },
    );
    expect(detectEnumSlots(EDUCATION_PACK, 'onlaynroq')).toEqual({});
  });

  it('validates pack configuration', () => {
    expect(() =>
      DomainPackSchema.parse({ ...EDUCATION_PACK, tools: ['get_quote'] }),
    ).toThrow();
    expect(() =>
      DomainPackSchema.parse({
        ...EDUCATION_PACK,
        locales: [...EDUCATION_PACK.locales, 'kaa'],
      }),
    ).toThrow(/missing question/);
    expect(() =>
      DomainPackSchema.parse({
        ...EDUCATION_PACK,
        slots: EDUCATION_PACK.slots.map((slot) => ({
          ...slot,
          requiredFor: [],
        })),
      }),
    ).toThrow(/required for search/);
  });
});

describe('facts and guardrail', () => {
  const provenance = {
    tool: 'get_quote',
    connectorKey: 'mock',
    sourceSystem: 'mock-education',
    sourceEntityId: 'o1',
    retrievedAt: '2026-10-23T10:00:00Z',
    tenantId: 't1',
    conversationId: 'c1',
    offerId: 'o1',
    live: true,
  };
  const now = new Date('2026-10-23T10:00:00Z');

  function store(): FactStore {
    const facts = new FactStore();
    facts.add({ kind: 'title', text: 'IELTS 7.0 Intensive' }, provenance);
    facts.add(
      {
        kind: 'price',
        money: { amount: '1500000', currency: 'UZS' },
        confirmedQuote: true,
      },
      provenance,
    );
    facts.add(
      {
        kind: 'price',
        money: { amount: '10.00', currency: 'USD' },
        confirmedQuote: true,
      },
      {
        ...provenance,
        sourceEntityId: 'o2',
        offerId: 'o2',
        validUntil: '2026-10-22T00:00:00Z',
      },
    );
    return facts;
  }
  const check = (
    draft: string,
    locale = UZ_LATN,
    customerTexts: string[] = [],
  ): ReturnType<typeof checkDraft> =>
    checkDraft(draft, {
      facts: store(),
      locale,
      customerTexts,
      timeZone: 'Asia/Tashkent',
      now,
      evidence: {
        tenantId: 't1',
        conversationId: 'c1',
        policy: displayPolicyFor({ liveQuote: true, availability: true }),
      },
    });

  it('renders referenced facts with locale formatting', () => {
    const result = check(
      '{{F1}} kursining narxi {{F2}}. Qachon boshlamoqchisiz?',
    );
    expect(result.violations).toEqual([]);
    expect(result.rendered?.replace(/\s/gu, ' ')).toBe(
      'IELTS 7.0 Intensive kursining narxi 1 500 000 soʻm. Qachon boshlamoqchisiz?',
    );
  });

  it.each([
    ['Narxi {{F7}}', 'UNKNOWN_FACT'],
    ['Narxi {{F3}}', 'STALE_FACT'],
    ['Narxi 900 000', 'UNSOURCED_NUMBER'],
    ['{{F1}} 12 kishilik guruh', 'UNSOURCED_NUMBER'],
    ['Narxi {{F2}}, ya’ni taxminan dollar', 'UNSOURCED_CURRENCY'],
    ['Bugun 20 foiz chegirma bor', 'FORBIDDEN_CLAIM'],
    ['Men search_catalog vositasidan foydalandim', 'PROMPT_LEAK'],
    ['Ваш курс {{F1}} подходит.', 'SCRIPT_MISMATCH'],
    ['   ', 'EMPTY'],
  ])('blocks %s (%s)', (draft, violation) => {
    expect(check(draft).violations).toContain(violation);
  });

  it('allows numbers the customer wrote and digits inside item titles', () => {
    expect(
      check('{{F1}} 16 yoshli o‘quvchi uchun mos.', UZ_LATN, [
        'Qizim 16 yoshda',
      ]).violations,
    ).toEqual([]);
  });

  it('distinguishes Russian from Uzbek Cyrillic', () => {
    const russian =
      'Здравствуйте, этот курс вам подходит, напишите когда удобно заниматься';
    expect(check(russian, UZ_CYRL).violations).toContain('LANGUAGE_MISMATCH');
    expect(check(russian, RU).violations).toEqual([]);
  });
});

describe('locale packs', () => {
  it('are honest beta packs: none is stable without native review', () => {
    for (const pack of INITIAL_LOCALE_PACKS) {
      expect(pack).toMatchObject({ status: 'beta', nativeReviewed: false });
    }
    expect(() => new LocaleRegistry([{ ...EN, status: 'stable' }])).toThrow(
      /native review/,
    );
  });

  it('cover every template and handover reason in each locale', () => {
    const reasons = Object.keys(UZ_LATN.templates.handover).sort();
    for (const pack of INITIAL_LOCALE_PACKS) {
      expect(Object.keys(pack.templates.handover).sort()).toEqual(reasons);
      for (const text of Object.values(pack.templates.handover))
        expect(text.length).toBeGreaterThan(10);
    }
  });

  it('keeps each locale in its own script', () => {
    const cyr = (text: string): boolean => /[\u0400-\u04ff]/u.test(text);
    for (const pack of INITIAL_LOCALE_PACKS) {
      const texts = [
        pack.templates.greeting,
        pack.templates.noResults,
        ...Object.values(pack.templates.handover),
        ...EDUCATION_PACK.slots.map((slot) => slot.questions[pack.id]!),
      ];
      for (const text of texts) expect(cyr(text)).toBe(pack.script === 'Cyrl');
    }
  });

  it('formats money exactly without rounding', () => {
    expect(formatMoney(EN, { amount: '150.00', currency: 'USD' })).toBe('$150');
    expect(formatMoney(EN, { amount: '19.995', currency: 'USD' })).toBe(
      '$19.995',
    );
    expect(
      formatMoney(RU, { amount: '1500000', currency: 'UZS' }).replace(
        /\s/gu,
        ' ',
      ),
    ).toBe('1 500 000 UZS');
    expect(
      formatMoney(UZ_CYRL, { amount: '1500000', currency: 'UZS' }).replace(
        /\s/gu,
        ' ',
      ),
    ).toBe('1 500 000 сўм');
  });
});
