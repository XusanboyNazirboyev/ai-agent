import { describe, expect, it } from 'vitest';
import { checkClip } from './speech-to-text.js';

describe('voice policy media types (ADR 042)', () => {
  it('accepts the containers voice notes use, with parameters and any case', () => {
    for (const mimeType of [
      'audio/ogg',
      'audio/ogg; codecs=opus',
      'audio/mpeg',
      'audio/mp4',
      'audio/aac',
      'AUDIO/WAV',
    ])
      expect(
        checkClip({ mimeType, durationSeconds: 5, size: 1_000 }),
        mimeType,
      ).toEqual({ ok: true });
  });

  it('refuses anything else before any audio leaves the server', () => {
    for (const mimeType of [
      'application/octet-stream',
      'text/html',
      'video/mp4',
      'image/png',
      '',
    ])
      expect(
        checkClip({ mimeType, durationSeconds: 5, size: 1_000 }),
        mimeType,
      ).toEqual({ ok: false, code: 'UNSUPPORTED_TYPE' });
  });
});
