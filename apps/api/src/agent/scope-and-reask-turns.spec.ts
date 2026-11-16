import { describe, expect, it } from 'vitest';
import { OUT_OF_SCOPE_MARK } from '../core/agent/agent-turn.js';
import { extractionSystemPrompt } from '../core/agent/prompts.js';
import type { LocaleId } from '../core/locales/locale-pack.js';
import type { PriorTurnSignal } from '../core/agent/stuck.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { TRAVEL_PACK } from '../packs/travel/travel.pack.js';
import { extraction, runTurn } from './testing/agent-harness.js';

// ADR 072, from the owner's test chat of 2026-11-16 (uz-Latn, education
// workspace): "turkiyaga 2 haftaga" and "sayohat qilmoqchiman" were both
// answered with the same "Qaysi fan yoki kurs bo'yicha o'qimoqchisiz?".

const uz = INITIAL_LOCALE_PACKS.find((locale) => locale.id === 'uz-Latn')!;
const subject = EDUCATION_PACK.slots.find((slot) => slot.key === 'subject')!;
const subjectQuestion = subject.questions['uz-Latn']!;
const subjectHint = subject.retryHint?.['uz-Latn'];

const asked = (slot: string): PriorTurnSignal => ({
  outcome: 'ASKED_SLOT',
  askedSlot: slot,
  slotsFilled: 0,
  textFingerprint: 'a',
});

describe('requests outside the business (ADR 072)', () => {
  it('says it cannot help, what it can do, and asks the next question', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'out_of_scope')]),
      text: 'turkiyaga 2 haftaga',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject')] },
      },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.handover).toBeUndefined();
    expect(result.reply).toBe(
      `${uz.templates.outOfScope} ${EDUCATION_PACK.capabilities['uz-Latn']} ${subjectQuestion}`,
    );
    expect(result.askedSlot).toBe(OUT_OF_SCOPE_MARK);
    // Code-rendered: no facts.
    expect(result.reply).not.toMatch(/\d/u);
  });

  it('offers a person the second time in a row instead of repeating itself', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'out_of_scope')]),
      text: 'sayohat qilmoqchiman',
      input: {
        conversationLocale: 'uz-Latn',
        progress: {
          priorTurns: [
            asked('subject'),
            {
              outcome: 'ANSWERED',
              askedSlot: OUT_OF_SCOPE_MARK,
              slotsFilled: 0,
              textFingerprint: 'b',
            },
          ],
        },
      },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.handover).toBeUndefined();
    expect(result.reply).toBe(
      `${uz.templates.outOfScope} ${uz.templates.offerOperator}`,
    );
  });

  it('trusts the slots over the label: a stated pack slot continues the normal flow', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ format: 'online' }, 'out_of_scope'),
      ]),
      text: 'online',
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result.outcome).toBe('ASKED_SLOT');
    expect(result.askedSlot).toBe('subject');
    expect(result.reply).not.toContain(uz.templates.outOfScope);
  });

  it('is answered in the customer locale for every locale of both packs', async () => {
    for (const pack of [EDUCATION_PACK, TRAVEL_PACK])
      for (const localeId of pack.locales as LocaleId[]) {
        const locale = INITIAL_LOCALE_PACKS.find((l) => l.id === localeId)!;
        const [language, script] =
          localeId === 'uz-Cyrl'
            ? ['uz', 'Cyrl']
            : localeId === 'uz-Latn'
              ? ['uz', 'Latn']
              : [localeId, localeId === 'ru' ? 'Cyrl' : 'Latn'];
        const { result } = await runTurn({
          pack,
          provider: new ScriptedLlmProvider([
            extraction({}, 'out_of_scope', language, script, pack),
          ]),
          text: 'x',
          input: { conversationLocale: localeId },
        });
        expect(result.reply.startsWith(locale.templates.outOfScope)).toBe(true);
        expect(result.reply).toContain(pack.capabilities[localeId]!);
      }
  });

  it('tells the extraction model what out_of_scope means', () => {
    const prompt = extractionSystemPrompt(EDUCATION_PACK, INITIAL_LOCALE_PACKS);
    expect(prompt).toMatch(/- out_of_scope: /u);
    expect(prompt).toContain(EDUCATION_PACK.prompt.businessRole);
  });
});

describe('asking a missing detail again (ADR 072)', () => {
  it('asks the first time plainly', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'other')]),
      text: 'bilmadim',
      input: { conversationLocale: 'uz-Latn', history: [] },
    });
    expect(result.outcome).toBe('ASKED_SLOT');
    expect(result.reply).not.toContain(uz.templates.notUnderstood);
  });

  it('never repeats the same question word for word: says so and adds the hint', async () => {
    expect(subjectHint).toBeTruthy();
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'other')]),
      text: 'bilmadim',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject')] },
      },
    });
    expect(result.outcome).toBe('ASKED_SLOT');
    expect(result.askedSlot).toBe('subject');
    expect(result.reply).toBe(
      `${uz.templates.notUnderstood} ${subjectQuestion} ${subjectHint}`,
    );
  });

  it('still hands over when the same question gets no progress again and again', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'other')]),
      text: 'bilmadim',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject'), asked('subject')] },
      },
    });
    expect(result).toMatchObject({ outcome: 'HANDOVER', handover: 'STUCK' });
  });

  it('every search-required slot of both packs has a hint in every pack locale, with no digits', () => {
    for (const pack of [EDUCATION_PACK, TRAVEL_PACK])
      for (const slot of pack.slots.filter((s) =>
        s.requiredFor.includes('search'),
      ))
        for (const localeId of pack.locales) {
          const hint = slot.retryHint?.[localeId];
          expect(hint, `${pack.key}.${slot.key}.${localeId}`).toBeTruthy();
          expect(hint).not.toMatch(/\d/u);
        }
  });
});
