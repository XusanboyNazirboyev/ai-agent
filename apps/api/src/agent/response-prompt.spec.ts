import { describe, expect, it } from 'vitest';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { UZ_LATN } from '../locales/locale-packs.js';
import { responseSystemPrompt } from '../core/agent/prompts.js';

describe('responseSystemPrompt', () => {
  it('tells the model not to greet again inside a conversation (staging 2026-11-23)', () => {
    expect(responseSystemPrompt(EDUCATION_PACK, UZ_LATN)).toContain(
      'Once the conversation has started, never greet again',
    );
  });
});
