import { describe, expect, it } from 'vitest';
import type { AudioClip } from '../core/speech/speech-to-text.js';
import { ElevenLabsSpeechToText } from './elevenlabs-speech-to-text.js';

const KEY = 'test-placeholder-key';
const CLIP: AudioClip = {
  data: new Uint8Array([1, 2, 3, 4]),
  mimeType: 'audio/ogg',
  durationSeconds: 2.4,
};

interface Seen {
  url: string;
  headers: Record<string, string>;
  form: FormData;
}

function transport(
  reply: { status?: number; body?: unknown; hang?: boolean } = {},
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      form: init?.body as FormData,
    });
    if (reply.hang)
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? { text: 'Salom' }), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: fake as typeof fetch, seen };
}

describe('ElevenLabsSpeechToText', () => {
  it('posts the audio as multipart form data with the key in a header', async () => {
    const { fetch, seen } = transport({
      body: { text: ' Assalomu   alaykum ', language_code: 'uzb' },
    });
    const stt = new ElevenLabsSpeechToText({ apiKey: KEY, fetch });
    const result = await stt.transcribe(CLIP);

    expect(result).toMatchObject({
      ok: true,
      text: 'Assalomu alaykum',
      language: 'uzb',
      billedSeconds: 3,
    });
    expect(seen[0]!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(seen[0]!.headers['xi-api-key']).toBe(KEY);
    expect(seen[0]!.url).not.toContain(KEY);
    expect(seen[0]!.form.get('model_id')).toBe('scribe_v2');
    const file = seen[0]!.form.get('file') as File;
    expect(file.type).toBe('audio/ogg');
    expect(file.size).toBe(4);
    // No language hint: the provider detects the language itself.
    expect(seen[0]!.form.has('language_code')).toBe(false);
  });

  it('maps the language hint to an ISO-639-1 code and sends keyterms', async () => {
    const { fetch, seen } = transport();
    const stt = new ElevenLabsSpeechToText({
      apiKey: KEY,
      fetch,
      keyterms: ['IELTS', 'Chilonzor'],
    });
    await stt.transcribe(CLIP, { languageHint: 'ru' });
    expect(seen[0]!.form.get('language_code')).toBe('ru');
    expect(seen[0]!.form.getAll('keyterms')).toEqual(['IELTS', 'Chilonzor']);
  });

  it('forces Uzbek only when the hint says Uzbek', async () => {
    const { fetch, seen } = transport();
    const stt = new ElevenLabsSpeechToText({ apiKey: KEY, fetch });
    await stt.transcribe(CLIP, { languageHint: 'uz-Latn' });
    expect(seen[0]!.form.get('language_code')).toBe('uz');
  });

  it('turns an empty transcript into UNINTELLIGIBLE', async () => {
    const { fetch } = transport({ body: { text: '   ' } });
    const stt = new ElevenLabsSpeechToText({ apiKey: KEY, fetch });
    expect(await stt.transcribe(CLIP)).toMatchObject({
      ok: false,
      code: 'UNINTELLIGIBLE',
    });
  });

  it('maps HTTP errors and a malformed body to PROVIDER_ERROR, without leaking text', async () => {
    for (const reply of [
      { status: 401, body: { detail: { message: 'bad key sk_secret' } } },
      { status: 429, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { nope: true } },
    ]) {
      const { fetch } = transport(reply);
      const stt = new ElevenLabsSpeechToText({ apiKey: KEY, fetch });
      const result = await stt.transcribe(CLIP);
      expect(result).toEqual({ ok: false, code: 'PROVIDER_ERROR' });
    }
  });

  it('times out instead of waiting for ever', async () => {
    const { fetch } = transport({ hang: true });
    const stt = new ElevenLabsSpeechToText({
      apiKey: KEY,
      fetch,
      timeoutMs: 30,
    });
    expect(await stt.transcribe(CLIP)).toEqual({
      ok: false,
      code: 'TIMEOUT',
    });
  });

  it('stops when the caller aborts', async () => {
    const { fetch } = transport({ hang: true });
    const stt = new ElevenLabsSpeechToText({ apiKey: KEY, fetch });
    const abort = new AbortController();
    const pending = stt.transcribe(CLIP, { signal: abort.signal });
    abort.abort();
    expect(await pending).toEqual({ ok: false, code: 'PROVIDER_ERROR' });
  });
});
