import { describe, expect, it } from 'vitest';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { extraction, runTurn } from './testing/agent-harness.js';

// ADR 043 (owner decision 2026-11-07): a public comment is answered (in
// private) only when it asks something or shows interest.

const comment = {
  origin: 'public_comment' as const,
  conversationLocale: 'uz-Latn' as const,
};

describe('public comment turns (ADR 043)', () => {
  it('answers a comment that asks what the business offers', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'capabilities')]),
      text: 'Qanday kurslar bor?',
      input: comment,
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.reply).toContain(EDUCATION_PACK.capabilities['uz-Latn']);
  });

  it.each([
    ['other', 'Zo‘r post 🔥'],
    ['small_talk', 'Ajoyib!'],
    ['greeting', 'Salom'],
    ['complaint', 'Eng yomon markaz'],
    ['human_request', 'Operator kerak'],
  ] as const)(
    'skips a %s comment without any reply or handover',
    async (intent, text) => {
      const provider = new ScriptedLlmProvider([extraction({}, intent)]);
      const { result } = await runTurn({ provider, text, input: comment });
      expect(result).toMatchObject({ outcome: 'NO_REPLY', reply: '' });
      expect(result.handover).toBeUndefined();
      // Only the extraction call: nothing is generated for a skipped comment.
      expect(provider.calls).toHaveLength(1);
    },
  );

  it('keeps the earlier slots when a comment is skipped', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'matematika' }, 'other'),
      ]),
      text: 'matematika zo‘r',
      input: { ...comment, slots: {} },
    });
    expect(result.outcome).toBe('NO_REPLY');
    expect(result.slots).toEqual({});
  });

  it('never treats a comment as an opt-out, and makes no model call for it', async () => {
    const provider = new ScriptedLlmProvider([extraction({}, 'other')]);
    const { result } = await runTurn({
      provider,
      text: '/stop',
      input: comment,
    });
    expect(result.optOut).toBeUndefined();
    expect(result.outcome).toBe('NO_REPLY');
  });

  it('stays silent when the model is unavailable (no handover notice in public threads)', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([]),
      text: 'Narxi qancha?',
      input: comment,
    });
    expect(result).toMatchObject({ outcome: 'NO_REPLY', reply: '' });
    expect(result.handover).toBeUndefined();
  });

  it('a direct message with the same text is still answered as before', async () => {
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([extraction({}, 'small_talk')]),
      text: 'Ajoyib!',
      input: { conversationLocale: 'uz-Latn' },
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.reply).not.toBe('');
  });
});
