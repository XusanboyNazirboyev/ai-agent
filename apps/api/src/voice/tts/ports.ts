/**
 * One-shot text-to-speech for spoken replies to voice notes (ADR 055).
 * Distinct from the streaming call port in `../ports.ts` (ADR 045), which this
 * stage does not touch.
 */

export interface SpeechAudio {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** Null when the container does not say (only WAV is parsed). */
  readonly sampleRateHz: number | null;
  readonly durationMs: number | null;
}

export type TtsErrorCode =
  | 'UNSUPPORTED_LANGUAGE'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'EMPTY_AUDIO'
  | 'INVALID_RESPONSE'
  | 'TEXT_TOO_LONG'
  | 'TRANSCODE_FAILED'
  | 'AUDIO_TOO_LARGE'
  | 'EMPTY_TEXT';

/** Typed failure. The message never contains the text or the audio. */
export class TtsError extends Error {
  constructor(
    readonly code: TtsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}

export interface SynthesizeInput {
  readonly text: string;
  /** A locale or language tag such as `ru`, `ru-RU` or `en`. */
  readonly language: string;
  readonly signal?: AbortSignal;
}

export interface TextToSpeech {
  readonly provider: string;
  supportsLanguage(language: string): boolean;
  synthesize(input: SynthesizeInput): Promise<SpeechAudio>;
}

/** ISO 639-1 prefix of a locale tag (`ru-RU` -> `ru`), lower case. */
export function languagePrefix(language: string): string {
  return language.trim().split(/[-_]/u)[0]?.toLowerCase() ?? '';
}
