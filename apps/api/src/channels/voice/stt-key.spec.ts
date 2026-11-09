import { describe, expect, it } from 'vitest';
import { FallbackSpeechToText } from '../../speech/fallback-speech-to-text.js';
import { GeminiSpeechToText } from '../../speech/gemini-speech-to-text.js';
import { buildSpeechToText, sttApiKey } from './voice-transcription.service.js';

describe('sttApiKey (ADR 042)', () => {
  it('prefers a dedicated STT_API_KEY', () => {
    expect(sttApiKey({ STT_API_KEY: 'stt', GEMINI_API_KEY: 'gemini' })).toBe(
      'stt',
    );
  });

  it('falls back to the paid GEMINI_API_KEY', () => {
    expect(sttApiKey({ GEMINI_API_KEY: 'gemini' })).toBe('gemini');
  });

  it('is undefined when neither is set', () => {
    expect(sttApiKey({})).toBeUndefined();
  });
});

describe('buildSpeechToText (ADR 042)', () => {
  const base = { STT_PROVIDER: 'gemini' as const, GEMINI_API_KEY: 'g' };

  it('is not configured without the gemini provider or a key', () => {
    expect(buildSpeechToText({ STT_PROVIDER: 'none' }).providerId).toBe('none');
    expect(buildSpeechToText({ STT_PROVIDER: 'gemini' }).providerId).toBe(
      'none',
    );
  });

  it('uses Gemini, with ElevenLabs as backup when its key is set', () => {
    expect(buildSpeechToText(base)).toBeInstanceOf(GeminiSpeechToText);
    const both = buildSpeechToText({ ...base, ELEVENLABS_API_KEY: 'e' });
    expect(both).toBeInstanceOf(FallbackSpeechToText);
    expect(both.providerId).toBe('gemini+elevenlabs');
  });

  it('leaves the backup out when STT_FALLBACK=none', () => {
    expect(
      buildSpeechToText({
        ...base,
        ELEVENLABS_API_KEY: 'e',
        STT_FALLBACK: 'none',
      }),
    ).toBeInstanceOf(GeminiSpeechToText);
  });
});
