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

  it('words small talk for the message itself (owner 2026-11-17: the same answer every time)', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({}, 'small_talk'),
        {
          kind: 'tools',
          text: "Mijozlarga kurs tanlashda yordam beryapman, men o'quv markazining AI yordamchisiman. Qaysi fanni o'rganmoqchisiz?",
        },
      ]),
      text: 'nima qilyapsan?',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject')] },
      },
    });
    expect(result.outcome).toBe('ANSWERED');
    // The model asks the next question in its own words; the slot is still set.
    expect(result.reply).toBe(
      "Mijozlarga kurs tanlashda yordam beryapman, men o'quv markazining AI yordamchisiman. Qaysi fanni o'rganmoqchisiz?",
    );
    expect(result.askedSlot).toBe('subject');
  });

  it("states today's date and time through the clock fact, rendered by code (DEF-021)", async () => {
    const now = new Date('2027-02-03T10:00:00Z');
    const provider = new ScriptedLlmProvider([
      extraction({}, 'small_talk'),
      {
        kind: 'tools',
        text: "Bugun {{F0}}. Qaysi fanni o'rganmoqchisiz?",
      },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'bugun nechanchi sana?',
      now,
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject')] },
      },
    });
    const shown = new Intl.DateTimeFormat('uz-Latn-UZ', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Asia/Tashkent',
    }).format(now);
    expect(result.outcome).toBe('ANSWERED');
    expect(result.reply).toBe(`Bugun ${shown}. Qaysi fanni o'rganmoqchisiz?`);
    expect(result.facts).toEqual([
      expect.objectContaining({
        id: 'F0',
        value: { kind: 'clock', iso: now.toISOString() },
      }),
    ]);
    expect(JSON.stringify(provider.calls[1]!.request)).toContain('{{F0}}');
  });

  it('never sends the previous bot message again verbatim', async () => {
    const repeated = "Rahmat, yaxshi! Qaysi fanni o'rganmoqchisiz?";
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({}, 'small_talk'),
        { kind: 'tools', text: repeated },
      ]),
      text: 'nima gap',
      input: {
        conversationLocale: 'uz-Latn',
        history: [
          { role: 'customer', text: 'qalaysan' },
          { role: 'agent', text: repeated },
        ],
        progress: { priorTurns: [asked('subject')] },
      },
    });
    // The worded draft equals the last bot message: the template is used.
    expect(result.reply).toBe(`Rahmat, yaxshi! ${subjectQuestion}`);
  });

  it('falls back to the template when the small-talk draft states a fact', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({}, 'small_talk'),
        {
          kind: 'tools',
          text: 'Yaxshi! Kurslarimiz 100 dollardan boshlanadi.',
        },
      ]),
      text: 'qalaysan',
      input: {
        conversationLocale: 'uz-Latn',
        progress: { priorTurns: [asked('subject')] },
      },
    });
    expect(result.reply).toBe(`Rahmat, yaxshi! ${subjectQuestion}`);
  });

  it('answers small talk with the template when the model is not available', async () => {
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
