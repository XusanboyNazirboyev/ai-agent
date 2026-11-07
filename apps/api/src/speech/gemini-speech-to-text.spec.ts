import { describe, expect, it, vi } from 'vitest';
import type { AudioClip } from '../core/speech/speech-to-text.js';
import {
  GeminiSpeechToText,
  type TranscribeCall,
} from './gemini-speech-to-text.js';

const clip: AudioClip = {
  data: new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
  mimeType: 'audio/ogg',
  durationSeconds: 3.2,
};

describe('GeminiSpeechToText (ADR 042)', () => {
  it('sends the clip inline with language codes and vocabulary, and returns the transcript', async () => {
    const call = vi.fn<TranscribeCall>(async () => ({
      output_text: '  IELTS   kursi bormi? ',
    }));
    const stt = new GeminiSpeechToText(call, 'gemini-3.5-transcribe', 15_000, [
      'IELTS',
      'Matematika',
    ]);
    await expect(
      stt.transcribe(clip, { languageHint: 'uz-Latn' }),
    ).resolves.toEqual({
      ok: true,
      text: 'IELTS kursi bormi?',
      billedSeconds: 4,
    });
    const [params, options] = call.mock.calls[0]!;
    expect(params).toEqual({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', data: 'T2dnUw==', mime_type: 'audio/ogg' }],
      generation_config: {
        transcription_config: {
          language_codes: ['uz-UZ', 'ru-RU'],
          custom_vocabulary: ['IELTS', 'Matematika'],
        },
      },
    });
    expect(options).toEqual({ timeout_ms: 15_000 });
  });

  it('lets the model detect among Uzbek, Russian and English without a hint', async () => {
    const call = vi.fn<TranscribeCall>(async () => ({ output_text: 'Salom' }));
    await new GeminiSpeechToText(call).transcribe(clip);
    expect(
      call.mock.calls[0]![0].generation_config.transcription_config,
    ).toEqual({ language_codes: ['uz-UZ', 'ru-RU', 'en-US'] });
  });

  it('maps an empty transcript, a provider error and a timeout to typed failures', async () => {
    await expect(
      new GeminiSpeechToText(async () => ({ output_text: '   ' })).transcribe(
        clip,
      ),
    ).resolves.toEqual({ ok: false, code: 'UNINTELLIGIBLE' });
    await expect(
      new GeminiSpeechToText(async () => {
        throw new Error('500 secret detail');
      }).transcribe(clip),
    ).resolves.toEqual({ ok: false, code: 'PROVIDER_ERROR' });
    await expect(
      new GeminiSpeechToText(async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }).transcribe(clip),
    ).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
  });
});
