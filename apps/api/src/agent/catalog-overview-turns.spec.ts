import { describe, expect, it } from 'vitest';
import { NO_RESULTS_MARK } from '../core/agent/agent-turn.js';
import { extractionSystemPrompt } from '../core/agent/prompts.js';
import type { PriorTurnSignal } from '../core/agent/stuck.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { languageRequest } from '../core/agent/language-policy.js';
import { extraction, LOCALES, runTurn } from './testing/agent-harness.js';

// ADR 073, from the owner's test chat of 2026-11-17 (uz-Latn, education
// workspace): "qanaqa kurslar bor" and "kurslar haqida malumot ber" got the
// "what I can do" text twice, "matem kursi bormi" went straight to a person,
// and "qaysi tillarni bilasan" was not answered.

const uz = INITIAL_LOCALE_PACKS.find((locale) => locale.id === 'uz-Latn')!;
const subject = EDUCATION_PACK.slots.find((slot) => slot.key === 'subject')!;
const subjectQuestion = subject.questions['uz-Latn']!;

const noResults: PriorTurnSignal = {
  outcome: 'NO_RESULTS',
  askedSlot: NO_RESULTS_MARK,
  slotsFilled: 1,
  textFingerprint: 'a',
};

describe('"what do you have?" (ADR 073)', () => {
  it('lists the catalog titles by code and asks the next question', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'catalog_overview')]),
      text: 'qanaqa kurslar bor',
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.handover).toBeUndefined();
    expect(result.reply.startsWith(uz.templates.catalogIntro)).toBe(true);
    expect(result.reply).toContain('IELTS');
    expect(result.reply.trim().endsWith(subjectQuestion)).toBe(true);
    expect(result.askedSlot).toBe('subject');
    expect(result.shownFactIds?.length).toBeGreaterThan(0);
    // Titles only: no prices, dates or seat counts.
    expect(result.reply).not.toMatch(/\d/u);
  });

  it('a message that names an item searches by it as usual', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }, 'catalog_overview'),
      ]),
      text: 'qanday IELTS kurslar bor',
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result.reply.startsWith(uz.templates.catalogIntro)).toBe(false);
  });
});

describe('nothing found (ADR 073)', () => {
  it('the first time lists what there is, asks again and offers a person, without handing over', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'matem' }, 'search'),
      ]),
      text: 'matem kursi bormi',
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result.outcome).toBe('NO_RESULTS');
    expect(result.handover).toBeUndefined();
    expect(result.askedSlot).toBe(NO_RESULTS_MARK);
    expect(result.reply.startsWith(uz.templates.noResults)).toBe(true);
    expect(result.reply).toContain(uz.templates.catalogIntro);
    expect(result.reply).toContain('IELTS');
    expect(result.reply).toContain(subjectQuestion);
    expect(result.reply.trim().endsWith(uz.templates.offerOperator)).toBe(true);
  });

  it('a second empty search in a row goes to a person', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'astronomiya' }, 'search'),
      ]),
      text: 'astronomiya kursi-chi?',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [noResults] },
      },
    });
    expect(result.outcome).toBe('NO_RESULTS');
    expect(result.handover).toBe('NO_DATA');
    expect(result.reply).toBe(
      `${uz.templates.noResults} ${uz.templates.offerOperator}`,
    );
  });
});

describe('which languages (ADR 073)', () => {
  it('answers with the reply languages and the next question', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'language_question')]),
      text: 'qaysi tillarni bilasan',
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.handover).toBeUndefined();
    // The model call is not scripted: the code template is the fallback.
    expect(result.reply).toBe(
      `${uz.templates.languagesSpoken} ${subjectQuestion}`,
    );
  });

  it('every locale names its reply languages without digits', () => {
    for (const locale of INITIAL_LOCALE_PACKS) {
      expect(
        locale.templates.languagesSpoken.length,
        locale.id,
      ).toBeGreaterThan(10);
      expect(locale.templates.languagesSpoken, locale.id).not.toMatch(/\d/u);
      expect(locale.templates.catalogIntro, locale.id).not.toMatch(/\d/u);
    }
  });

  it('tells the extraction model both intents apart from capabilities', () => {
    const prompt = extractionSystemPrompt(EDUCATION_PACK, INITIAL_LOCALE_PACKS);
    expect(prompt).toContain('catalog_overview');
    expect(prompt).toContain('language_question');
    expect(prompt).toMatch(/capabilities: asks in general/u);
  });
});

describe('asking for another language mid-chat (ADR 073)', () => {
  const ru = INITIAL_LOCALE_PACKS.find((locale) => locale.id === 'ru')!;
  const all = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const;

  it('reads informal requests as a switch to Russian', () => {
    for (const text of [
      'endi shu kurslar haqidagi malumotni ruschada yozib ber',
      'yaxshi menga kurslar haqidagi malumotni rus tilida javob ber',
      "shuni rus tilida bo'lsin",
    ])
      expect(languageRequest(text, LOCALES, all), text).toEqual({
        kind: 'locale',
        locale: 'ru',
      });
    for (const text of ['inglizcha gapr', 'endi english tilida gapr'])
      expect(languageRequest(text, LOCALES, all), text).toEqual({
        kind: 'locale',
        locale: 'en',
      });
    // A course name with no request verb is not a switch.
    expect(
      languageRequest('rus tili kursi bormi', LOCALES, all),
    ).toBeUndefined();
  });

  it('a switch that asks for the courses lists them in the new language', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'catalog_overview')]),
      text: 'yaxshi menga kurslar haqidagi malumotni rus tilida javob ber',
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result.locale).toBe('ru');
    expect(result.reply.startsWith(ru.templates.catalogIntro)).toBe(true);
    expect(result.reply).toContain('IELTS');
    expect(result.reply).not.toBe(ru.templates.languageSwitched);
  });

  it('"make that Russian" after a list lists it again in Russian', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'language_question')]),
      text: "shuni rus tilida bo'lsin",
      input: {
        conversationLocale: 'uz-Latn',
        history: [
          { role: 'customer', text: 'qanaqa kurslar bor' },
          {
            role: 'agent',
            text: `${uz.templates.catalogIntro}\n• IELTS Preparation\n• General English\n${subjectQuestion}`,
          },
        ],
      },
    });
    expect(result.locale).toBe('ru');
    expect(result.reply.startsWith(ru.templates.catalogIntro)).toBe(true);
  });

  it('a bare request is still acknowledged in the new language', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'other')]),
      text: 'rus tilida yozing',
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result.reply).toBe(ru.templates.languageSwitched);
  });
});
