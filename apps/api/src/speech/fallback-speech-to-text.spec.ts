import { describe, expect, it } from 'vitest';
import type {
  AudioClip,
  SpeechToText,
  TranscriptionResult,
} from '../core/speech/speech-to-text.js';
import { FallbackSpeechToText } from './fallback-speech-to-text.js';

const CLIP: AudioClip = {
  data: new Uint8Array([1]),
  mimeType: 'audio/ogg',
  durationSeconds: 3,
};

function fake(
  providerId: string,
  result: TranscriptionResult,
): SpeechToText & { hints: Array<string | undefined> } {
  const hints: Array<string | undefined> = [];
  return {
    providerId,
    model: `${providerId}-model`,
    hints,
    transcribe: (_clip, options): Promise<TranscriptionResult> => {
      hints.push(options?.languageHint);
      return Promise.resolve(result);
    },
  };
}

describe('FallbackSpeechToText (ADR 042)', () => {
  it('uses the primary answer when it succeeds', async () => {
    const primary = fake('gemini', { ok: true, text: 'Salom' });
    const backup = fake('elevenlabs', { ok: true, text: 'boshqa' });
    const stt = new FallbackSpeechToText(primary, backup, 'uz-Latn');
    expect(await stt.transcribe(CLIP)).toEqual({ ok: true, text: 'Salom' });
    expect(backup.hints).toHaveLength(0);
  });

  it('asks the backup, with its default language, when the primary errors or times out', async () => {
    for (const code of ['PROVIDER_ERROR', 'TIMEOUT'] as const) {
      const primary = fake('gemini', { ok: false, code });
      const backup = fake('elevenlabs', { ok: true, text: 'Salom' });
      const stt = new FallbackSpeechToText(primary, backup, 'uz-Latn');
      expect(await stt.transcribe(CLIP)).toEqual({ ok: true, text: 'Salom' });
      expect(backup.hints).toEqual(['uz-Latn']);
    }
  });

  it('keeps the primary verdict for silence or a refused clip (no second paid call)', async () => {
    for (const code of ['UNINTELLIGIBLE', 'NOT_CONFIGURED'] as const) {
      const primary = fake('gemini', { ok: false, code });
      const backup = fake('elevenlabs', { ok: true, text: 'x' });
      const stt = new FallbackSpeechToText(primary, backup, 'uz-Latn');
      expect(await stt.transcribe(CLIP)).toEqual({ ok: false, code });
      expect(backup.hints).toHaveLength(0);
    }
  });

  it('names both providers for metering and returns the backup failure when both fail', async () => {
    const primary = fake('gemini', {
      ok: false,
      code: 'PROVIDER_ERROR',
      usage: { inputTokens: 10, outputTokens: 0 },
    });
    const backup = fake('elevenlabs', { ok: false, code: 'TIMEOUT' });
    const stt = new FallbackSpeechToText(primary, backup, 'uz-Latn');
    expect(stt.providerId).toBe('gemini+elevenlabs');
    expect(await stt.transcribe(CLIP)).toEqual({ ok: false, code: 'TIMEOUT' });
  });

  it('asks the backup on silence too when told to (Groq first, owner 2026-11-21)', async () => {
    const primary = fake('groq', { ok: false, code: 'UNINTELLIGIBLE' });
    const backup = fake('gemini', { ok: true, text: 'Salom' });
    const strict = new FallbackSpeechToText(primary, backup, 'uz-Latn');
    expect(await strict.transcribe(CLIP)).toEqual({
      ok: false,
      code: 'UNINTELLIGIBLE',
    });
    const groqFirst = new FallbackSpeechToText(primary, backup, 'uz-Latn', [
      'PROVIDER_ERROR',
      'TIMEOUT',
      'UNINTELLIGIBLE',
    ]);
    expect(await groqFirst.transcribe(CLIP)).toEqual({
      ok: true,
      text: 'Salom',
    });
    expect(backup.hints).toEqual(['uz-Latn']);
  });
});
