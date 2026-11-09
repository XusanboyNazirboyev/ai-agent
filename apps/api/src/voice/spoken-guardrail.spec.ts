import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_POLICY } from '../core/agent/display-gate.js';
import { FactStore } from '../core/agent/facts.js';
import { EN, RU, UZ_LATN } from '../locales/locale-packs.js';
import {
  checkSpokenSentence,
  type SpokenCheckContext,
} from './spoken-guardrail.js';

const NOW = new Date('2026-11-09T10:00:00Z');
const SYSTEM =
  'Siz o‘quv markazining telefon operatorisiz. Faqat o‘zbek tilida qisqa javob bering.';

function context(
  overrides: Partial<SpokenCheckContext> = {},
): SpokenCheckContext {
  return {
    facts: new FactStore(),
    locale: UZ_LATN,
    customerTexts: ['Ingliz tili kursi bormi?'],
    timeZone: 'Asia/Tashkent',
    now: NOW,
    evidence: {
      tenantId: 't1',
      conversationId: 'c1',
      policy: {
        ...DEFAULT_DISPLAY_POLICY,
        requireLivePrice: false,
        requireLiveAvailability: false,
      },
    },
    systemPrompt: SYSTEM,
    ...overrides,
  };
}

describe('checkSpokenSentence', () => {
  it('passes a plain spoken sentence', () => {
    const result = checkSpokenSentence(
      'Albatta, qaysi kurs sizni qiziqtiradi?',
      context(),
    );
    expect(result.violations).toEqual([]);
    expect(result.rendered).toBe('Albatta, qaysi kurs sizni qiziqtiradi?');
  });

  it('keeps the text guardrail: digits the customer did not say are blocked', () => {
    expect(
      checkSpokenSentence(
        'Bizga +998 71 123 45 67 raqamiga qo‘ng‘iroq qiling.',
        context(),
      ).violations,
    ).toContain('UNSOURCED_NUMBER');
  });

  it('blocks invented contact handles, links and e-mail addresses', () => {
    for (const sentence of [
      'Telegramda @OquvMarkaz kanaliga yozing.',
      'Saytimiz www.markaz.uz manzilida.',
      'Batafsil t.me/markaz sahifasida.',
      'Xat yuboring: info@markaz.uz',
    ]) {
      expect(checkSpokenSentence(sentence, context()).violations).toContain(
        'UNSOURCED_CONTACT',
      );
    }
  });

  it('blocks numbers and dates spelled out in words', () => {
    for (const [sentence, locale] of [
      ['Narxi to‘rt yuz ellik ming.', UZ_LATN],
      ['Telefon raqam to‘qson bir besh.', UZ_LATN],
      ['Dars yigirma beshinchi noyabrda boshlanadi.', UZ_LATN],
      ['Курс стоит пятьсот тысяч.', RU],
      ['Занятия начинаются первого декабря.', RU],
      ['It costs four hundred dollars.', EN],
    ] as const) {
      expect(
        checkSpokenSentence(sentence, context({ locale, customerTexts: [] }))
          .violations,
        sentence,
      ).toContain('UNSOURCED_SPOKEN_FACT');
    }
  });

  it('allows a single small number word and words the customer said', () => {
    expect(
      checkSpokenSentence('Bir daqiqa, tekshirib beraman.', context())
        .violations,
    ).toEqual([]);
    expect(
      checkSpokenSentence(
        'Yigirma beshinchi noyabrni tekshirib ko‘raman.',
        context({
          customerTexts: ['Yigirma beshinchi noyabr kuni joy bormi?'],
        }),
      ).violations,
    ).toEqual([]);
  });

  it('blocks a sentence that repeats the system prompt', () => {
    expect(
      checkSpokenSentence(
        'Siz o‘quv markazining telefon operatorisiz, faqat o‘zbek tilida.',
        context(),
      ).violations,
    ).toContain('PROMPT_LEAK');
  });

  it('renders fact references by code', () => {
    const facts = new FactStore();
    const id = facts.add(
      { kind: 'title', text: 'Ingliz tili' },
      {
        tool: 'search_catalog',
        connectorKey: 'mock',
        sourceSystem: 'mock',
        sourceEntityId: 'i1',
        retrievedAt: NOW.toISOString(),
        tenantId: 't1',
        conversationId: 'c1',
      },
    );
    const result = checkSpokenSentence(
      `{{${id}}} kursi bor.`,
      context({ facts }),
    );
    expect(result.violations).toEqual([]);
    expect(result.rendered).toBe('Ingliz tili kursi bor.');
  });
});
