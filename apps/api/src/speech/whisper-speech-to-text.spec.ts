import { describe, expect, it } from 'vitest';
import type { AudioClip } from '../core/speech/speech-to-text.js';
import { WhisperSpeechToText } from './whisper-speech-to-text.js';

const KEY = 'test-placeholder-key';
const CLIP: AudioClip = {
  data: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/ogg',
  durationSeconds: 3.2,
};

function transport(reply: { status?: number; body?: unknown } = {}): {
  fetch: typeof fetch;
  seen: Array<{ url: string; headers: Record<string, string>; form: FormData }>;
} {
  const seen: Array<{
    url: string;
    headers: Record<string, string>;
    form: FormData;
  }> = [];
  const fake = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      form: init?.body as FormData,
    });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? { text: ' Salom ' }), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: fake as typeof fetch, seen };
}

describe('WhisperSpeechToText (OpenAI-compatible /audio/transcriptions)', () => {
  it('posts multipart audio with a bearer key to the configured provider', async () => {
    const { fetch, seen } = transport();
    const stt = new WhisperSpeechToText({
      providerId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1/',
      apiKey: KEY,
      model: 'whisper-large-v3',
      fetch,
    });
    const result = await stt.transcribe(CLIP);
    expect(result).toEqual({ ok: true, text: 'Salom', billedSeconds: 4 });
    expect(seen[0]!.url).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions',
    );
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.form.get('model')).toBe('whisper-large-v3');
    expect(seen[0]!.form.get('response_format')).toBe('json');
    expect((seen[0]!.form.get('file') as File).name).toBe('voice.ogg');
    expect(seen[0]!.form.has('language')).toBe(false);
  });

  it('sends the hinted language as ISO-639-1', async () => {
    const { fetch, seen } = transport();
    const stt = new WhisperSpeechToText({
      providerId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: KEY,
      model: 'whisper-large-v3',
      fetch,
    });
    await stt.transcribe(CLIP, { languageHint: 'uz-Cyrl' });
    expect(seen[0]!.form.get('language')).toBe('uz');
  });

  it('maps errors and empty text without returning provider text', async () => {
    for (const [reply, code] of [
      [
        { status: 401, body: { error: { message: 'bad key' } } },
        'PROVIDER_ERROR',
      ],
      [{ status: 200, body: { nope: 1 } }, 'PROVIDER_ERROR'],
      [{ status: 200, body: { text: '  ' } }, 'UNINTELLIGIBLE'],
    ] as const) {
      const { fetch } = transport(reply);
      const stt = new WhisperSpeechToText({
        providerId: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: KEY,
        model: 'whisper-large-v3',
        fetch,
      });
      expect(await stt.transcribe(CLIP)).toEqual({ ok: false, code });
    }
  });
});
