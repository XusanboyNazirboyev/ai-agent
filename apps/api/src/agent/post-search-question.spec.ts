import { describe, expect, it } from 'vitest';
import type { PriorTurnSignal } from '../core/agent/stuck.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { extraction, runTurn } from './testing/agent-harness.js';

/**
 * ADR 073 A2 for replies after a catalog search: the next detail is asked in
 * the model's own words, a detail asked in the previous reply and still
 * missing is not asked again, and the previous bot message is never sent
 * again word for word.
 */
const format = EDUCATION_PACK.slots.find((slot) => slot.key === 'format')!;
const formatQuestion = format.questions['uz-Latn']!;

const askedFormat: PriorTurnSignal = {
  outcome: 'ANSWERED',
  askedSlot: 'format',
  slotsFilled: 1,
  textFingerprint: 'a',
};

function responsePrompt(provider: ScriptedLlmProvider): string {
  const call = provider.calls.find((entry) => entry.type === 'tools');
  return JSON.stringify(call?.request.messages ?? []);
}

describe('the question after a search (ADR 073 A2)', () => {
  it('asks the missing detail in its own words and records it', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search'),
      {
        kind: 'tools',
        text: "{{F1}} bor. Onlayn o'qiysizmi yoki markazdami?",
      },
    ]);
    const { result } = await runTurn({ provider, text: 'IELTS bormi' });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.askedSlot).toBe('format');
    const prompt = responsePrompt(provider);
    expect(prompt).toContain('in your own words');
    expect(prompt).not.toContain('ask exactly this');
  });

  it('does not record a question the reply did not ask', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search'),
      { kind: 'tools', text: '{{F1}} bor.' },
    ]);
    const { result } = await runTurn({ provider, text: 'IELTS bormi' });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.askedSlot).toBeUndefined();
  });

  it('does not ask again a detail asked in the previous reply', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search'),
      { kind: 'tools', text: '{{F1}} bor.' },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'IELTS haqida yana aytib bering',
      input: { progress: { priorTurns: [askedFormat] } },
    });
    expect(result.outcome).toBe('ANSWERED');
    const prompt = responsePrompt(provider);
    expect(prompt).not.toContain(formatQuestion);
    expect(prompt).toContain('Do not ask for more details');
    expect(result.askedSlot).toBeUndefined();
  });

  it('the fallback offers a person instead of the same question', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search'),
      { kind: 'tools', text: 'Narxi 100 dollar.' },
      { kind: 'tools', text: 'Narxi 100 dollar.' },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'IELTS haqida yana aytib bering',
      input: { progress: { priorTurns: [askedFormat] } },
    });
    expect(result.outcome).toBe('FALLBACK');
    expect(result.reply).not.toContain(formatQuestion);
    expect(result.askedSlot).toBeUndefined();
  });

  it('never sends the previous bot message again word for word', async () => {
    const previous = 'IELTS Preparation bor.';
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search'),
      { kind: 'tools', text: '{{F1}} bor.' },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'IELTS bormi',
      input: {
        history: [
          { role: 'customer', text: 'IELTS bormi' },
          { role: 'agent', text: previous },
        ],
      },
    });
    expect(result.reply.trim()).not.toBe(previous);
  });
});
