import { describe, expect, it } from 'vitest';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../core/llm/scripted-llm-provider.js';
import { extraction, runTurn } from './testing/agent-harness.js';

/**
 * A turn that falls back to the code-rendered option list must say why, so a
 * low pass rate on a live model can be traced to its pipeline stage (the
 * model cut off at its output limit, wrote nothing, or its extraction was not
 * valid) instead of being guessed.
 */
describe('typed reasons on the turn result', () => {
  const text = 'How much is the IELTS course?';
  const extracted = extraction({ subject: 'IELTS' }, 'search', 'en', 'Latn');

  const cases: ReadonlyArray<[string, ScriptStep, 'truncated' | 'empty']> = [
    [
      'a draft cut at the output limit',
      { kind: 'tools', text: 'Partial', stop: 'max_tokens' },
      'truncated',
    ],
    ['an empty draft', { kind: 'tools', text: '' }, 'empty'],
  ];

  it.each(cases)(
    'falls back with a typed reason for %s',
    async (_name, step, expected) => {
      const provider = new ScriptedLlmProvider([extracted, step]);
      const { result } = await runTurn({ provider, text });
      expect(result.outcome).toBe('FALLBACK');
      expect(result.draftFailure).toBe(expected);
      expect(result.extractionFailure).toBeUndefined();
    },
  );

  it('an extraction the model returned malformed is reported, with no intent', async () => {
    const provider = new ScriptedLlmProvider([
      { kind: 'structured', failure: 'malformed' },
    ]);
    const { result } = await runTurn({ provider, text });
    expect(result.extractionFailure).toBe('malformed');
    expect(result.intent).toBeUndefined();
    expect(result.draftFailure).toBeUndefined();
  });
});
