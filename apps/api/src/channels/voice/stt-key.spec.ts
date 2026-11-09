import { describe, expect, it } from 'vitest';
import { sttApiKey } from './voice-transcription.service.js';

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
