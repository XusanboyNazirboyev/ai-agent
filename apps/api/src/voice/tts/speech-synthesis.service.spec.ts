import { describe, expect, it } from 'vitest';
import type { AudioTranscoder } from './audio-transcoder.js';
import { FakeTextToSpeech } from './fake-tts.js';
import { TtsError } from './ports.js';
import {
  CHANNEL_MAX_BYTES,
  SpeechSynthesisService,
} from './speech-synthesis.service.js';

const settings = { enabledChannels: ['telegram', 'instagram'] as const };

function transcoder(
  over: { bytes?: Uint8Array; fail?: boolean | Error } = {},
): {
  impl: AudioTranscoder;
  calls: { to: string; fromMime: string }[];
} {
  const calls: { to: string; fromMime: string }[] = [];
  const impl: AudioTranscoder = {
    transcode: (input) => {
      calls.push({ to: input.to, fromMime: input.fromMime });
      if (over.fail instanceof Error) return Promise.reject(over.fail);
      if (over.fail)
        return Promise.reject(new TtsError('TRANSCODE_FAILED', 'x'));
      return Promise.resolve({
        bytes: over.bytes ?? new Uint8Array([1, 2, 3]),
        mimeType: input.to === 'ogg-opus' ? 'audio/ogg' : 'audio/mp4',
      });
    },
  };
  return { impl, calls };
}

const input = { text: 'Hello, how can I help?', language: 'en', settings };

describe('SpeechSynthesisService', () => {
  it('speaks for telegram as ogg-opus and for instagram as m4a-aac', async () => {
    const t = transcoder();
    const service = new SpeechSynthesisService({
      provider: new FakeTextToSpeech(),
      transcoder: t.impl,
    });
    const tg = await service.speak({ ...input, channel: 'telegram' });
    const ig = await service.speak({ ...input, channel: 'instagram' });
    expect(tg.outcome).toBe('SPOKEN');
    expect(tg.spoken?.mimeForChannel).toBe('audio/ogg');
    expect(ig.spoken?.mimeForChannel).toBe('audio/mp4');
    expect(t.calls.map((c) => c.to)).toEqual(['ogg-opus', 'm4a-aac']);
    expect(t.calls[0]?.fromMime).toBe('audio/wav');
  });

  it('skips with the policy reason and never calls the provider', async () => {
    const provider = new FakeTextToSpeech();
    const service = new SpeechSynthesisService({
      provider,
      transcoder: transcoder().impl,
    });
    const facts = await service.speak({
      ...input,
      text: 'It costs 5 dollars',
      channel: 'telegram',
    });
    expect(facts).toEqual({ spoken: null, outcome: 'SKIPPED_CONTAINS_FACTS' });
    const off = await service.speak({
      ...input,
      channel: 'telegram',
      settings: { enabledChannels: [] },
    });
    expect(off.outcome).toBe('SKIPPED_DISABLED');
    const uz = await service.speak({
      ...input,
      language: 'uz-Latn',
      channel: 'telegram',
    });
    expect(uz.outcome).toBe('SKIPPED_UNSUPPORTED_LANGUAGE');
    expect(provider.calls).toHaveLength(0);
  });

  it('reports a missing provider (TTS_PROVIDER=off)', async () => {
    const service = new SpeechSynthesisService({
      provider: null,
      transcoder: transcoder().impl,
    });
    expect(
      (await service.speak({ ...input, channel: 'telegram' })).outcome,
    ).toBe('FAILED_PROVIDER_OFF');
  });

  it.each([
    'PROVIDER_UNAVAILABLE',
    'TIMEOUT',
    'EMPTY_AUDIO',
    'INVALID_RESPONSE',
  ] as const)('never throws on provider %s', async (code) => {
    const service = new SpeechSynthesisService({
      provider: new FakeTextToSpeech({ failWith: code }),
      transcoder: transcoder().impl,
    });
    const result = await service.speak({ ...input, channel: 'telegram' });
    expect(result).toEqual({ spoken: null, outcome: `FAILED_${code}` });
  });

  it('maps a transcode failure and an unexpected error', async () => {
    const a = new SpeechSynthesisService({
      provider: new FakeTextToSpeech(),
      transcoder: transcoder({ fail: true }).impl,
    });
    expect((await a.speak({ ...input, channel: 'telegram' })).outcome).toBe(
      'FAILED_TRANSCODE_FAILED',
    );
    const b = new SpeechSynthesisService({
      provider: new FakeTextToSpeech(),
      transcoder: transcoder({ fail: new Error('boom') }).impl,
    });
    expect((await b.speak({ ...input, channel: 'telegram' })).outcome).toBe(
      'FAILED_UNEXPECTED',
    );
  });

  it('enforces the channel size limits', async () => {
    expect(CHANNEL_MAX_BYTES.telegram).toBe(50 * 1024 * 1024);
    expect(CHANNEL_MAX_BYTES.instagram).toBe(25 * 1024 * 1024);
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    const service = new SpeechSynthesisService({
      provider: new FakeTextToSpeech(),
      transcoder: transcoder({ bytes: big }).impl,
    });
    expect(
      (await service.speak({ ...input, channel: 'instagram' })).outcome,
    ).toBe('FAILED_AUDIO_TOO_LARGE');
    // The same size is fine for Telegram.
    expect(
      (await service.speak({ ...input, channel: 'telegram' })).outcome,
    ).toBe('SPOKEN');
  });
});
