/**
 * Per-locale routing of speech providers (ADR 045, owner decision V1).
 * Provider and model ids are config strings; no client is created here.
 * Model ids below are config defaults taken from the ADR vendor table and
 * stay unverified until the adapters are written (rule 7).
 */
import type { LocaleId } from '../core/locales/locale-pack.js';
import type { StreamingSpeechToText, StreamingTextToSpeech } from './ports.js';

export type SpeechKind = 'stt' | 'tts';

export interface ProviderChoice {
  readonly provider: string;
  readonly model: string;
}

export interface LocaleRoute {
  readonly primary: ProviderChoice;
  readonly fallbacks: readonly ProviderChoice[];
}

export type VoiceRoutingConfig = Readonly<
  Record<LocaleId, Readonly<Record<SpeechKind, LocaleRoute>>>
>;

/** Locales each provider is documented to support (ADR 045 table). */
export const PROVIDER_LOCALES: Readonly<Record<string, readonly LocaleId[]>> = {
  elevenlabs: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
  deepgram: ['ru', 'en'],
  cartesia: ['ru', 'en'],
};

const ELEVEN_STT: ProviderChoice = {
  provider: 'elevenlabs',
  model: 'scribe_v2_realtime',
};
const ELEVEN_TTS: ProviderChoice = {
  provider: 'elevenlabs',
  model: 'eleven_v4_turbo',
};
const DEEPGRAM_STT: ProviderChoice = {
  provider: 'deepgram',
  model: 'nova-3',
};
const CARTESIA_TTS: ProviderChoice = {
  provider: 'cartesia',
  model: 'sonic-3.6',
};

const UZ_ROUTE = {
  stt: { primary: ELEVEN_STT, fallbacks: [] },
  tts: { primary: ELEVEN_TTS, fallbacks: [] },
} as const;
const RU_EN_ROUTE = {
  stt: { primary: ELEVEN_STT, fallbacks: [DEEPGRAM_STT] },
  tts: { primary: ELEVEN_TTS, fallbacks: [CARTESIA_TTS] },
} as const;

export const DEFAULT_VOICE_ROUTING: VoiceRoutingConfig = {
  'uz-Latn': UZ_ROUTE,
  'uz-Cyrl': UZ_ROUTE,
  ru: RU_EN_ROUTE,
  en: RU_EN_ROUTE,
};

export function providerSupportsLocale(
  provider: string,
  locale: LocaleId,
): boolean {
  return PROVIDER_LOCALES[provider]?.includes(locale) ?? false;
}

/** Ordered candidates (primary first) that actually support the locale. */
export function routeCandidates(
  locale: LocaleId,
  kind: SpeechKind,
  config: VoiceRoutingConfig = DEFAULT_VOICE_ROUTING,
): ProviderChoice[] {
  const route = config[locale][kind];
  return [route.primary, ...route.fallbacks].filter((c) =>
    providerSupportsLocale(c.provider, locale),
  );
}

/** Config check: a route that names a provider without locale support. */
export function validateRouting(config: VoiceRoutingConfig): string[] {
  const problems: string[] = [];
  for (const locale of Object.keys(config) as LocaleId[]) {
    for (const kind of ['stt', 'tts'] as const) {
      const route = config[locale][kind];
      for (const c of [route.primary, ...route.fallbacks]) {
        if (!providerSupportsLocale(c.provider, locale)) {
          problems.push(`${kind}/${locale}: ${c.provider} does not support it`);
        }
      }
    }
  }
  return problems;
}

/** Registered adapters, picked by the first routed candidate that exists. */
export class VoiceProviderRegistry {
  private readonly stt = new Map<string, StreamingSpeechToText>();
  private readonly tts = new Map<string, StreamingTextToSpeech>();

  constructor(
    private readonly config: VoiceRoutingConfig = DEFAULT_VOICE_ROUTING,
  ) {}

  registerStt(adapter: StreamingSpeechToText): void {
    this.stt.set(adapter.provider, adapter);
  }

  registerTts(adapter: StreamingTextToSpeech): void {
    this.tts.set(adapter.provider, adapter);
  }

  resolveStt(
    locale: LocaleId,
  ): { choice: ProviderChoice; adapter: StreamingSpeechToText } | undefined {
    for (const choice of routeCandidates(locale, 'stt', this.config)) {
      const adapter = this.stt.get(choice.provider);
      if (adapter) return { choice, adapter };
    }
    return undefined;
  }

  resolveTts(
    locale: LocaleId,
  ): { choice: ProviderChoice; adapter: StreamingTextToSpeech } | undefined {
    for (const choice of routeCandidates(locale, 'tts', this.config)) {
      const adapter = this.tts.get(choice.provider);
      if (adapter) return { choice, adapter };
    }
    return undefined;
  }
}
