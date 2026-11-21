import { z } from 'zod';
import type {
  AudioClip,
  SpeechToText,
  TranscriptionResult,
} from '../core/speech/speech-to-text.js';

/**
 * Deepgram Nova-3 speech-to-text (owner 2026-11-21). Docs read 2026-11-21:
 * https://developers.deepgram.com/docs/models-languages-overview (nova-3
 * monolingual lists Uzbek `uz`), /docs/language-detection (detection cannot
 * be limited to `uz`, and unrestricted detection labelled Uzbek as Turkish
 * in our measurement), /docs/the-deepgram-model-improvement-partnership-program
 * (`mip_opt_out=true`: audio kept only while the request runs) and
 * https://deepgram.com/pricing (Nova-3 monolingual about $0.0048 a minute).
 * `POST https://api.deepgram.com/v1/listen`, `Authorization: Token`, the raw
 * audio as the body.
 *
 * Measured 2026-11-21 with the project key: Uzbek speech (clean and noisy
 * OGG/Opus) came back word for word at confidence 0.96 to 1.0, where Groq
 * Whisper misspelled it; Russian and English forced to `uz` scored 0.69 and
 * 0.73. So the language is forced to Uzbek and a transcript below
 * `minConfidence` is reported as UNSUPPORTED_LANGUAGE, which lets the next engine (Groq,
 * which detects the language itself) try. No provider error text is returned
 * or logged.
 */

const ResponseSchema = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(z.object({ transcript: z.string(), confidence: z.number() }))
            .min(1),
        }),
      )
      .min(1),
  }),
});

const ENDPOINT =
  'https://api.deepgram.com/v1/listen?model=nova-3&language=uz&smart_format=true&mip_opt_out=true';

export interface DeepgramSpeechToTextOptions {
  readonly apiKey: string;
  readonly minConfidence?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class DeepgramSpeechToText implements SpeechToText {
  readonly providerId = 'deepgram';
  readonly model = 'nova-3';
  private readonly request: typeof fetch;

  constructor(private readonly options: DeepgramSpeechToTextOptions) {
    this.request = options.fetch ?? fetch;
  }

  async transcribe(
    clip: AudioClip,
    options: { languageHint?: string; signal?: AbortSignal } = {},
  ): Promise<TranscriptionResult> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await this.request(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Token ${this.options.apiKey}`,
          'content-type': clip.mimeType.split(';')[0]!.trim().toLowerCase(),
        },
        body: clip.data as Uint8Array<ArrayBuffer>,
        signal,
      });
    } catch {
      return {
        ok: false,
        code:
          timeout.aborted && !options.signal?.aborted
            ? 'TIMEOUT'
            : 'PROVIDER_ERROR',
      };
    }
    if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR' };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, code: 'PROVIDER_ERROR' };
    }
    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, code: 'PROVIDER_ERROR' };
    const best = parsed.data.results.channels[0]!.alternatives[0]!;
    const text = best.transcript.replace(/\s+/gu, ' ').trim();
    if (!text) return { ok: false, code: 'UNINTELLIGIBLE' };
    // Most likely not Uzbek: let the next engine detect the language.
    if (best.confidence < (this.options.minConfidence ?? 0.8))
      return { ok: false, code: 'UNSUPPORTED_LANGUAGE' };
    return {
      ok: true,
      text,
      language: 'uz',
      confidence: best.confidence,
      billedSeconds: Math.ceil(clip.durationSeconds),
    };
  }
}
