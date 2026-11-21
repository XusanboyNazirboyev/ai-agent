import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsReplyTts } from './elevenlabs-reply-tts.js';

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);

describe('ElevenLabsReplyTts (voice replies)', () => {
  it('posts the text, voice, model and language and returns the MP3', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(mp3, { status: 200 })),
    );
    const tts = new ElevenLabsReplyTts({ apiKey: 'k', voiceId: 'v', fetch });
    expect(await tts.synthesize('Salom', 'uz')).toEqual(mp3);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128',
    );
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k');
    expect(JSON.parse(String(init.body))).toEqual({
      inputs: [{ text: 'Salom', voice_id: 'v' }],
      model_id: 'eleven_v4_turbo',
      language_code: 'uz',
    });
  });

  it('returns null for a refused call, a network error, empty or too long text', async () => {
    const refused = new ElevenLabsReplyTts({
      apiKey: 'k',
      voiceId: 'v',
      fetch: (): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 402 })),
    });
    expect(await refused.synthesize('Salom')).toBeNull();
    const broken = new ElevenLabsReplyTts({
      apiKey: 'k',
      voiceId: 'v',
      fetch: (): Promise<Response> => Promise.reject(new Error('down')),
    });
    expect(await broken.synthesize('Salom')).toBeNull();
    const never = vi.fn();
    const tts = new ElevenLabsReplyTts({
      apiKey: 'k',
      voiceId: 'v',
      fetch: never,
    });
    expect(await tts.synthesize('  ')).toBeNull();
    expect(await tts.synthesize('a'.repeat(2_001))).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});
