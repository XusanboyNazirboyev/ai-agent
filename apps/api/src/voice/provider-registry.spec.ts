import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_ROUTING,
  VoiceProviderRegistry,
  providerSupportsLocale,
  routeCandidates,
  validateRouting,
  type VoiceRoutingConfig,
} from './provider-registry.js';
import {
  FakeStreamingSpeechToText,
  FakeStreamingTextToSpeech,
} from './fakes.js';
import { VirtualClock } from './virtual-clock.js';

describe('voice provider routing (owner decision V1)', () => {
  it('routes Uzbek to ElevenLabs only', () => {
    for (const locale of ['uz-Latn', 'uz-Cyrl'] as const) {
      expect(routeCandidates(locale, 'stt')).toEqual([
        { provider: 'elevenlabs', model: 'scribe_v2_realtime' },
      ]);
      expect(routeCandidates(locale, 'tts')).toEqual([
        { provider: 'elevenlabs', model: 'eleven_v4_turbo' },
      ]);
    }
  });

  it('gives ru/en ElevenLabs first with Deepgram and Cartesia as fallbacks', () => {
    for (const locale of ['ru', 'en'] as const) {
      expect(routeCandidates(locale, 'stt').map((c) => c.provider)).toEqual([
        'elevenlabs',
        'deepgram',
      ]);
      expect(routeCandidates(locale, 'tts').map((c) => c.provider)).toEqual([
        'elevenlabs',
        'cartesia',
      ]);
    }
  });

  it('never lets deepgram or cartesia serve Uzbek, even when misconfigured', () => {
    expect(providerSupportsLocale('deepgram', 'uz-Latn')).toBe(false);
    expect(providerSupportsLocale('cartesia', 'uz-Cyrl')).toBe(false);
    const bad: VoiceRoutingConfig = {
      ...DEFAULT_VOICE_ROUTING,
      'uz-Latn': {
        stt: {
          primary: { provider: 'deepgram', model: 'nova-3' },
          fallbacks: [{ provider: 'elevenlabs', model: 'scribe_v2_realtime' }],
        },
        tts: DEFAULT_VOICE_ROUTING['uz-Latn'].tts,
      },
    };
    expect(validateRouting(bad)).toHaveLength(1);
    expect(validateRouting(DEFAULT_VOICE_ROUTING)).toEqual([]);
    expect(
      routeCandidates('uz-Latn', 'stt', bad).map((c) => c.provider),
    ).toEqual(['elevenlabs']);
  });

  it('resolves the first registered adapter along the route', () => {
    const clock = new VirtualClock();
    const registry = new VoiceProviderRegistry();
    const stt = new FakeStreamingSpeechToText({ clock });
    registry.registerStt({ provider: 'deepgram', open: stt.open.bind(stt) });
    expect(registry.resolveStt('ru')?.choice.provider).toBe('deepgram');
    expect(registry.resolveStt('uz-Latn')).toBeUndefined();
    expect(registry.resolveTts('ru')).toBeUndefined();
    const eleven = new FakeStreamingTextToSpeech({ clock });
    registry.registerTts({
      provider: 'elevenlabs',
      open: eleven.open.bind(eleven),
    });
    expect(registry.resolveTts('uz-Latn')?.choice.model).toBe(
      'eleven_v4_turbo',
    );
  });
});
