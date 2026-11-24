import { describe, expect, it } from 'vitest';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { extraction, runTurn } from './testing/agent-harness.js';

// ADR 090: a reply to one of the business's Instagram stories is a direct
// message; the model is told it cannot see the story.
const NOTE = "a reply to one of the business's Instagram stories";

describe('Instagram story replies (ADR 090)', () => {
  it('is answered as a direct message and the model is told about the story', async () => {
    const provider = new ScriptedLlmProvider([extraction({}, 'small_talk')]);
    const { result } = await runTurn({
      provider,
      text: 'Ajoyib!',
      input: { conversationLocale: 'uz-Latn', origin: 'story_reply' },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(provider.calls.length).toBeGreaterThan(0);
    for (const call of provider.calls)
      expect(JSON.stringify(call)).toContain(NOTE);
  });

  it('says nothing about stories for an ordinary message', async () => {
    const provider = new ScriptedLlmProvider([extraction({}, 'small_talk')]);
    await runTurn({
      provider,
      text: 'Ajoyib!',
      input: { conversationLocale: 'uz-Latn' },
    });
    for (const call of provider.calls)
      expect(JSON.stringify(call)).not.toContain(NOTE);
  });
});
