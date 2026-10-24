import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkClip,
  decideVoice,
  DEFAULT_VOICE_POLICY,
  NotConfiguredSpeechToText,
  worstCaseTranscriptionNano,
} from '../core/speech/speech-to-text.js';

describe('voice clip limits (checked before any audio leaves the server)', () => {
  const ok = { mimeType: 'audio/ogg', durationSeconds: 12, size: 90_000 };
  it('accepts an ordinary voice note', () => {
    expect(checkClip(ok)).toEqual({ ok: true });
    expect(checkClip({ ...ok, mimeType: 'audio/ogg; codecs=opus' })).toEqual({
      ok: true,
    });
  });
  it.each([
    [{ size: DEFAULT_VOICE_POLICY.maxBytes + 1 }, 'TOO_LARGE'],
    [{ size: 0 }, 'TOO_LARGE'],
    [{ durationSeconds: 61 }, 'TOO_LONG'],
    [{ durationSeconds: 0 }, 'TOO_LONG'],
    [{ mimeType: 'video/mp4' }, 'UNSUPPORTED_TYPE'],
    [{ mimeType: 'application/octet-stream' }, 'UNSUPPORTED_TYPE'],
  ])('refuses %j as %s', (over, code) => {
    expect(checkClip({ ...ok, ...over })).toEqual({ ok: false, code });
  });
});

describe('what a transcription outcome means', () => {
  it('uses a usable transcript, flagged for confirmation when confidence is unknown or low', () => {
    expect(
      decideVoice(
        { ok: true, text: ' IELTS   kursi kerak ', confidence: 0.9 },
        0,
      ),
    ).toEqual({
      action: 'USE_TEXT',
      text: 'IELTS kursi kerak',
      needsConfirmation: false,
    });
    expect(decideVoice({ ok: true, text: 'IELTS kerak' }, 0)).toMatchObject({
      needsConfirmation: true,
    });
    expect(
      decideVoice({ ok: true, text: 'IELTS kerak', confidence: 0.3 }, 0),
    ).toMatchObject({ needsConfirmation: true });
  });

  it('never turns a failed or empty transcript into an empty customer message', () => {
    for (const outcome of [
      { ok: true as const, text: '' },
      { ok: true as const, text: '   ' },
      { ok: true as const, text: 'a' },
      { ok: false as const, code: 'UNINTELLIGIBLE' as const },
      { ok: false as const, code: 'PROVIDER_ERROR' as const },
      { ok: false as const, code: 'TIMEOUT' as const },
      { ok: false as const, code: 'NOT_CONFIGURED' as const },
      { ok: false as const, code: 'UNSUPPORTED_LANGUAGE' as const },
      { ok: false as const, code: 'TOO_LONG' as const },
    ]) {
      const decision = decideVoice(outcome, 0);
      expect(decision.action, JSON.stringify(outcome)).toBe('ASK_TO_TYPE');
      expect(decision).not.toHaveProperty('text');
    }
  });

  it('recommends a person after repeated failures, so the loop is bounded', () => {
    const failure = { ok: false as const, code: 'UNINTELLIGIBLE' as const };
    expect(decideVoice(failure, 0).action).toBe('ASK_TO_TYPE');
    expect(decideVoice(failure, 1)).toEqual({
      action: 'HANDOVER',
      reason: 'UNINTELLIGIBLE',
    });
    expect(decideVoice(failure, 5).action).toBe('HANDOVER');
  });

  it('has a default adapter that always fails with a typed reason', async () => {
    const stt = new NotConfiguredSpeechToText();
    expect(await stt.transcribe()).toEqual({
      ok: false,
      code: 'NOT_CONFIGURED',
    });
    expect(decideVoice(await stt.transcribe(), 0).action).toBe('ASK_TO_TYPE');
  });
});

describe('transcription cost bound', () => {
  it('rounds up whole seconds and never exceeds the policy’s maximum clip', () => {
    expect(worstCaseTranscriptionNano(6_000_000, { durationSeconds: 30 })).toBe(
      3_000_000,
    );
    expect(
      worstCaseTranscriptionNano(6_000_000, { durationSeconds: 29.1 }),
    ).toBe(3_000_000);
    expect(
      worstCaseTranscriptionNano(6_000_000, { durationSeconds: 3_600 }),
    ).toBe(6_000_000);
    expect(worstCaseTranscriptionNano(0, { durationSeconds: 30 })).toBe(0);
  });
});

describe('logs carry no customer content', () => {
  // Static guard for the Phase 5/6 modules: structured log calls may carry
  // ids, codes and error names, never message text, queries or phone numbers.
  const dirs = ['knowledge', 'followup', 'handover', 'leads', 'background'].map(
    (d) => resolve(__dirname, '..', d),
  );
  const files = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map((f) => join(dir, f)),
  );
  it.each(files.map((f) => [f.split('/src/')[1], f] as const))(
    '%s',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      const calls =
        source.match(
          /logger\.(?:log|warn|error)\(\s*JSON\.stringify\(\{[\s\S]*?\}\)/gu,
        ) ?? [];
      for (const call of calls)
        expect(call, call).not.toMatch(
          /\b(?:text|query|phone|customerText|body)\b\s*[:,}]/u,
        );
    },
  );
});
