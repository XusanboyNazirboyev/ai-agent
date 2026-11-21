import { describe, expect, it, vi } from 'vitest';
import { FirstReplyTts, GeminiReplyTts } from './gemini-reply-tts.js';

const wav = new Uint8Array([82, 73, 70, 70]);
const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);

describe('GeminiReplyTts (voice replies)', () => {
  it('asks the TTS model for audio and encodes the WAV it returns', async () => {
    const call = vi.fn(() =>
      Promise.resolve({
        output_audio: { data: Buffer.from(wav).toString('base64') },
      }),
    );
    const encode = vi.fn((): Promise<Uint8Array | null> =>
      Promise.resolve(ogg),
    );
    const tts = new GeminiReplyTts({
      call,
      model: 'gemini-3.8-flash-lite-tts',
      voice: 'Kore',
      encode,
    });
    expect(await tts.synthesize('Salom')).toEqual(ogg);
    expect((call.mock.calls as unknown as unknown[][])[0]![0]).toEqual({
      model: 'gemini-3.8-flash-lite-tts',
      input: [
        { type: 'user_input', content: [{ type: 'text', text: 'Salom' }] },
      ],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
    });
    expect(encode).toHaveBeenCalledWith(wav);
  });

  it('returns null without audio, on an error, or for empty and long text', async () => {
    const encode = (): Promise<Uint8Array | null> => Promise.resolve(ogg);
    const base = { model: 'm', voice: 'Kore', encode };
    const empty = new GeminiReplyTts({
      ...base,
      call: (): Promise<object> => Promise.resolve({}),
    });
    expect(await empty.synthesize('Salom')).toBeNull();
    const failing = new GeminiReplyTts({
      ...base,
      call: (): Promise<object> => Promise.reject(new Error('quota')),
    });
    expect(await failing.synthesize('Salom')).toBeNull();
    const never = vi.fn();
    const tts = new GeminiReplyTts({ ...base, call: never });
    expect(await tts.synthesize(' ')).toBeNull();
    expect(await tts.synthesize('a'.repeat(2_001))).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe('FirstReplyTts', () => {
  it('uses ElevenLabs only when Gemini gives no audio', async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33]);
    const gemini = {
      synthesize: vi.fn((): Promise<Uint8Array | null> =>
        Promise.resolve(null),
      ),
    };
    const eleven = {
      synthesize: vi.fn((): Promise<Uint8Array | null> => Promise.resolve(mp3)),
    };
    expect(
      await new FirstReplyTts([gemini, eleven]).synthesize('Salom', 'uz'),
    ).toEqual(mp3);
    expect(eleven.synthesize).toHaveBeenCalledWith('Salom', 'uz');
    const ok = {
      synthesize: vi.fn((): Promise<Uint8Array | null> => Promise.resolve(ogg)),
    };
    const unused = { synthesize: vi.fn() };
    expect(await new FirstReplyTts([ok, unused]).synthesize('Salom')).toEqual(
      ogg,
    );
    expect(unused.synthesize).not.toHaveBeenCalled();
  });
});
