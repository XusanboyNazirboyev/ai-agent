import { describe, expect, it } from 'vitest';
import type { AudioClip } from '../core/speech/speech-to-text.js';
import { DeepgramSpeechToText } from './deepgram-speech-to-text.js';

const CLIP: AudioClip = {
  data: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/ogg; codecs=opus',
  durationSeconds: 3.2,
};

function answer(transcript: string, confidence: number): { results: object } {
  return {
    results: { channels: [{ alternatives: [{ transcript, confidence }] }] },
  };
}

function transport(reply: { status?: number; body?: unknown } = {}): {
  fetch: typeof fetch;
  seen: Array<{ url: string; init: RequestInit }>;
} {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fake = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({ url: String(url), init: init! });
    return Promise.resolve(
      new Response(
        JSON.stringify(reply.body ?? answer(' Salom  dunyo ', 0.98)),
        {
          status: reply.status ?? 200,
        },
      ),
    );
  };
  return { fetch: fake as typeof fetch, seen };
}

describe('DeepgramSpeechToText (Nova-3, Uzbek)', () => {
  it('posts the raw audio forced to Uzbek, opted out of training', async () => {
    const { fetch, seen } = transport();
    const stt = new DeepgramSpeechToText({ apiKey: 'test-key', fetch });
    expect(await stt.transcribe(CLIP)).toEqual({
      ok: true,
      text: 'Salom dunyo',
      language: 'uz',
      confidence: 0.98,
      billedSeconds: 4,
    });
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe(
      'https://api.deepgram.com/v1/listen',
    );
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('language')).toBe('uz');
    expect(url.searchParams.get('mip_opt_out')).toBe('true');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Token test-key');
    expect(headers['content-type']).toBe('audio/ogg');
    expect(seen[0]!.init.body).toBe(CLIP.data);
  });

  it('hands low confidence (another language) and silence to the next engine', async () => {
    const low = new DeepgramSpeechToText({
      apiKey: 'k',
      fetch: transport({ body: answer('Skolka Stoit', 0.69) }).fetch,
    });
    expect(await low.transcribe(CLIP)).toEqual({
      ok: false,
      code: 'UNSUPPORTED_LANGUAGE',
    });
    const silent = new DeepgramSpeechToText({
      apiKey: 'k',
      fetch: transport({ body: answer('  ', 1) }).fetch,
    });
    expect(await silent.transcribe(CLIP)).toEqual({
      ok: false,
      code: 'UNINTELLIGIBLE',
    });
  });

  it('reports provider errors and bad bodies without their text', async () => {
    for (const reply of [
      { status: 401, body: { err_msg: 'secret detail' } },
      { body: { unexpected: true } },
    ]) {
      const stt = new DeepgramSpeechToText({
        apiKey: 'k',
        fetch: transport(reply).fetch,
      });
      expect(await stt.transcribe(CLIP)).toEqual({
        ok: false,
        code: 'PROVIDER_ERROR',
      });
    }
    const down = new DeepgramSpeechToText({
      apiKey: 'k',
      fetch: (() => Promise.reject(new Error('down'))) as typeof fetch,
    });
    expect(await down.transcribe(CLIP)).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    });
  });
});
