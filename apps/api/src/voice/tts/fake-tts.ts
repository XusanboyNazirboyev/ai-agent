/** Deterministic fake TextToSpeech for tests (ADR 055). */
import {
  languagePrefix,
  type SpeechAudio,
  type SynthesizeInput,
  type TextToSpeech,
  TtsError,
  type TtsErrorCode,
} from './ports.js';
import { buildWav } from './wav.js';

export interface FakeTtsOptions {
  readonly languages?: readonly string[];
  readonly failWith?: TtsErrorCode;
  readonly latencyMs?: number;
  readonly sampleRateHz?: number;
  /** Samples of the generated WAV (default 480 = 10 ms at 48 kHz). */
  readonly samples?: number;
  /** Override the bytes returned (for size-limit tests). */
  readonly bytes?: Uint8Array;
  readonly mimeType?: string;
}

export class FakeTextToSpeech implements TextToSpeech {
  readonly provider = 'fake';
  readonly calls: SynthesizeInput[] = [];

  constructor(private readonly options: FakeTtsOptions = {}) {}

  supportsLanguage(language: string): boolean {
    return (this.options.languages ?? ['ru', 'en']).includes(
      languagePrefix(language),
    );
  }

  async synthesize(input: SynthesizeInput): Promise<SpeechAudio> {
    this.calls.push(input);
    if (this.options.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.latencyMs);
        input.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new TtsError('TIMEOUT', 'aborted'));
        });
      });
    }
    if (this.options.failWith) {
      throw new TtsError(this.options.failWith, 'fake failure');
    }
    const rate = this.options.sampleRateHz ?? 48_000;
    const samples = this.options.samples ?? 480;
    return {
      bytes: this.options.bytes ?? buildWav(rate, samples),
      mimeType: this.options.mimeType ?? 'audio/wav',
      sampleRateHz: rate,
      durationMs: Math.round((samples / rate) * 1000),
    };
  }
}
