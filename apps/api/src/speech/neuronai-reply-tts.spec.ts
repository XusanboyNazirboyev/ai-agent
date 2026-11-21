import { describe, expect, it, vi } from 'vitest';
import { NeuronAiReplyTts } from './neuronai-reply-tts.js';

const wav = new Uint8Array([82, 73, 70, 70]);
const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const encode = (): Promise<Uint8Array | null> => Promise.resolve(ogg);

function answer(status: number, body: Uint8Array = wav): Promise<Response> {
  return Promise.resolve(new Response(new Uint8Array(body), { status }));
}

describe('NeuronAiReplyTts (voice replies)', () => {
  it('posts the text with the chosen Uzbek voice and encodes the WAV', async () => {
    const fetch = vi.fn(() => answer(200));
    const encodeSpy = vi.fn(encode);
    const tts = new NeuronAiReplyTts({
      apiKey: 'test-key',
      voice: 'kamola',
      fetch: fetch as unknown as typeof globalThis.fetch,
      encode: encodeSpy,
    });
    expect(await tts.synthesize('Salom', 'uz')).toEqual(ogg);
    const [url, init] = (
      fetch.mock.calls as unknown as [string, RequestInit][]
    )[0]!;
    expect(url).toBe('https://my.neuronai.uz/api/v1/tts/synthesize');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-key',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Salom',
      voice_id: 'kamola',
      language: 'uz',
      quality: 'standard',
    });
    expect(encodeSpy).toHaveBeenCalledWith(wav);
  });

  it('leaves other languages, errors and bad text to the next engine', async () => {
    const never = vi.fn(() => answer(200));
    const base = { apiKey: 'k', voice: 'muhriddin', encode };
    const tts = new NeuronAiReplyTts({
      ...base,
      fetch: never as unknown as typeof fetch,
    });
    expect(await tts.synthesize('Привет', 'ru')).toBeNull();
    expect(await tts.synthesize(' ', 'uz')).toBeNull();
    expect(await tts.synthesize('a'.repeat(2_001))).toBeNull();
    expect(never).not.toHaveBeenCalled();
    for (const fetch of [
      (): Promise<Response> => answer(402),
      (): Promise<Response> => answer(200, new Uint8Array()),
      (): Promise<Response> => Promise.reject(new Error('timeout')),
    ]) {
      const failing = new NeuronAiReplyTts({
        ...base,
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      expect(await failing.synthesize('Salom')).toBeNull();
    }
  });
});
