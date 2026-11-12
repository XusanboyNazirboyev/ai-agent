/**
 * Orchestrates one spoken reply (ADR 055): policy, provider, transcode, size
 * limit. Pure orchestration, no Nest wiring, never throws to the caller.
 */
import type { AudioTranscoder, TranscodeTarget } from './audio-transcoder.js';
import { type SpeechAudio, TtsError, type TextToSpeech } from './ports.js';
import {
  decideSpeech,
  type NoSpeechReason,
  type SpeechChannel,
  type SpeechSettings,
} from './speech-policy.js';

export const CHANNEL_TARGET: Readonly<Record<SpeechChannel, TranscodeTarget>> =
  { telegram: 'ogg-opus', instagram: 'm4a-aac' };

/** Telegram sendVoice 50 MB; Instagram audio 25 MB (docs read 2026-11-12). */
export const CHANNEL_MAX_BYTES: Readonly<Record<SpeechChannel, number>> = {
  telegram: 50 * 1024 * 1024,
  instagram: 25 * 1024 * 1024,
};

/** Metrics-friendly outcome codes. */
export type SpeechOutcome =
  | 'SPOKEN'
  | `SKIPPED_${NoSpeechReason}`
  | 'FAILED_UNSUPPORTED_LANGUAGE'
  | 'FAILED_PROVIDER_UNAVAILABLE'
  | 'FAILED_TIMEOUT'
  | 'FAILED_EMPTY_AUDIO'
  | 'FAILED_INVALID_RESPONSE'
  | 'FAILED_TEXT_TOO_LONG'
  | 'FAILED_EMPTY_TEXT'
  | 'FAILED_TRANSCODE_FAILED'
  | 'FAILED_AUDIO_TOO_LARGE'
  | 'FAILED_PROVIDER_OFF'
  | 'FAILED_UNEXPECTED';

export interface SpokenReply {
  readonly audio: SpeechAudio;
  readonly mimeForChannel: string;
}

export interface SpeakInput {
  readonly text: string;
  readonly language: string;
  readonly channel: SpeechChannel;
  readonly settings: SpeechSettings;
  readonly signal?: AbortSignal;
}

export type SpeakResult =
  | { readonly spoken: SpokenReply; readonly outcome: 'SPOKEN' }
  | { readonly spoken: null; readonly outcome: SpeechOutcome };

export interface SpeechSynthesisDeps {
  /** Null when TTS_PROVIDER=off. */
  readonly provider: TextToSpeech | null;
  readonly transcoder: AudioTranscoder;
}

export class SpeechSynthesisService {
  constructor(private readonly deps: SpeechSynthesisDeps) {}

  async speak(input: SpeakInput): Promise<SpeakResult> {
    const decision = decideSpeech({
      replyText: input.text,
      language: input.language,
      channel: input.channel,
      settings: input.settings,
    });
    if (!decision.speak) {
      return { spoken: null, outcome: `SKIPPED_${decision.reason}` };
    }
    const { provider } = this.deps;
    if (!provider) return { spoken: null, outcome: 'FAILED_PROVIDER_OFF' };
    try {
      const audio = await provider.synthesize({
        text: input.text,
        language: input.language,
        signal: input.signal,
      });
      const converted = await this.deps.transcoder.transcode({
        bytes: audio.bytes,
        fromMime: audio.mimeType,
        to: CHANNEL_TARGET[input.channel],
      });
      if (converted.bytes.length > CHANNEL_MAX_BYTES[input.channel]) {
        return { spoken: null, outcome: 'FAILED_AUDIO_TOO_LARGE' };
      }
      return {
        outcome: 'SPOKEN',
        spoken: {
          audio: {
            bytes: converted.bytes,
            mimeType: converted.mimeType,
            sampleRateHz: converted.mimeType === 'audio/ogg' ? 48_000 : null,
            durationMs: audio.durationMs,
          },
          mimeForChannel: converted.mimeType,
        },
      };
    } catch (error) {
      if (error instanceof TtsError) {
        return {
          spoken: null,
          outcome: `FAILED_${error.code}` as SpeechOutcome,
        };
      }
      return { spoken: null, outcome: 'FAILED_UNEXPECTED' };
    }
  }
}
