import { describe, expect, it } from 'vitest';
import { FRUSTRATION_MARK } from '../core/agent/agent-turn.js';
import type { PriorTurnSignal } from '../core/agent/stuck.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { extraction, runTurn } from './testing/agent-harness.js';

// ADR 041, from the staging conversation of 2026-11-07 (uz-Latn): "salom",
// "nma gap", "qanday yordam beraolasan?" ended in a STUCK handover and
// "qandaysiga tushunmaslik mumkin..." in an immediate COMPLAINT handover.

const asked = (slot: string): PriorTurnSignal => ({
  outcome: 'ASKED_SLOT',
  askedSlot: slot,
  slotsFilled: 0,
  textFingerprint: 'a',
});
const subjectQuestion = EDUCATION_PACK.slots.find(
  (slot) => slot.key === 'subject',
)!.questions['uz-Latn']!;

describe('conversational turns (ADR 041)', () => {
  it('answers "what can you help with" with the pack capabilities and the next question, not STUCK', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'capabilities')]),
      text: 'qanday yordam beraolasan?',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject'), asked('subject')] },
      },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.handover).toBeUndefined();
    expect(result.reply).toBe(
      `${EDUCATION_PACK.capabilities['uz-Latn']} ${subjectQuestion}`,
    );
    expect(result.askedSlot).toBe('subject');
    // No digits: the answer carries no facts.
    expect(result.reply).not.toMatch(/\d/u);
  });

  it('answers small talk briefly and asks the next question', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'small_talk')]),
      text: 'nma gap',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject')] },
      },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.reply).toBe(`Rahmat, yaxshi! ${subjectQuestion}`);
  });

  it('apologises once for frustration and hands over the second time', async () => {
    const first = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'frustration')]),
      text: 'qandaysiga tushunmaslik mumkin yordam sozini?',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject')] },
      },
    });
    expect(first.result.outcome).toBe('ANSWERED');
    expect(first.result.handover).toBeUndefined();
    expect(first.result.askedSlot).toBe(FRUSTRATION_MARK);
    expect(first.result.reply).toContain('Kechirasiz');
    expect(first.result.reply).toContain(subjectQuestion);

    const second = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'frustration')]),
      text: 'yana tushunmading',
      input: {
        conversationLocale: 'uz-Latn',
        progress: {
          priorTurns: [
            asked('subject'),
            {
              outcome: 'ANSWERED',
              askedSlot: FRUSTRATION_MARK,
              slotsFilled: 0,
              textFingerprint: 'b',
            },
          ],
        },
      },
    });
    expect(second.result).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'COMPLAINT',
    });
  });

  it('still hands a real complaint to a person at once', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'complaint')]),
      text: "pulimni qaytaring, dars bo'lmadi",
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'COMPLAINT',
    });
  });

  it('every pack locale has a capabilities text and every locale the new templates', async () => {
    for (const locale of EDUCATION_PACK.locales)
      expect(EDUCATION_PACK.capabilities[locale]).toBeTruthy();
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'capabilities')]),
      text: 'what can you do?',
      input: { conversationLocale: 'en' },
    });
    expect(result.reply.startsWith(EDUCATION_PACK.capabilities.en!)).toBe(true);
  });

  it('puts locale examples in the extraction prompt, never the eval texts', async () => {
    const { extractionSystemPrompt } = await import('../core/agent/prompts.js');
    const { INITIAL_LOCALE_PACKS } = await import('../locales/locale-packs.js');
    const prompt = extractionSystemPrompt(EDUCATION_PACK, INITIAL_LOCALE_PACKS);
    expect(prompt).toContain('- capabilities: "nima qila olasiz?"');
    for (const evalText of [
      'qanday yordam beraolasan?',
      'nma gap',
      "siz kimsiz o'zi?",
      'qandaysiga tusshunmaslik mumkin yordam sozini?',
    ])
      expect(prompt).not.toContain(evalText);
  });
});
