import { z } from 'zod';
import type {
  AudioClip,
  SpeechToText,
  TranscriptionResult,
} from '../core/speech/speech-to-text.js';

/**
 * Speech-to-text with ElevenLabs Scribe, the file (batch) endpoint, for
 * customer voice notes (ADR 042). A voice note needs no real-time socket.
 * Docs read 2026-11-09: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 * - `POST https://api.elevenlabs.io/v1/speech-to-text`, `multipart/form-data`,
 *   header `xi-api-key`;
 * - fields: `model_id` (required; the page's examples use `scribe_v2`),
 *   `file`, `language_code` (ISO-639-1/3; null = detected automatically),
 *   `keyterms` (up to 1,000, each at most 50 characters and 5 words; an extra
 *   20% surcharge);
 * - response: `text`, `language_code`, `language_probability` (language
 *   detection only: it is NOT a transcript confidence, so none is returned),
 *   `words`.
 * The page says all major audio formats are supported but does not name
 * ogg/opus, and does not mention Uzbek: both are verified by measurement
 * (scripts/stt-compare.ts), not assumed. Billing is by audio time, not by
 * token, so no token pricing is reported and the metering layer keeps the
 * worst case counted. Audio is sent only after `checkClip` passed; nothing
 * about it, and no provider error text, is logged or returned.
 */

export const ELEVENLABS_STT_FILE_MODEL = 'scribe_v2';

/** ISO-639-1 codes from our locale ids; anything else is auto-detected. */
const LANGUAGE: Readonly<Record<string, string>> = {
  'uz-Latn': 'uz',
  'uz-Cyrl': 'uz',
  uz: 'uz',
  ru: 'ru',
  en: 'en',
};

const ResponseSchema = z.object({
  text: z.string(),
  language_code: z.string().optional(),
});

export interface ElevenLabsSpeechToTextOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Tenant words (course names, places) that improve recognition. */
  readonly keyterms?: readonly string[];
  readonly fetch?: typeof fetch;
}

export class ElevenLabsSpeechToText implements SpeechToText {
  readonly providerId = 'elevenlabs';
  readonly model: string;
  private readonly endpoint: string;
  private readonly request: typeof fetch;

  constructor(private readonly options: ElevenLabsSpeechToTextOptions) {
    this.model = options.model ?? ELEVENLABS_STT_FILE_MODEL;
    this.endpoint = `${(options.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/u, '')}/v1/speech-to-text`;
    this.request = options.fetch ?? fetch;
  }

  async transcribe(
    clip: AudioClip,
    options: { languageHint?: string; signal?: AbortSignal } = {},
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    form.set('model_id', this.model);
    form.set(
      'file',
      new Blob([clip.data as Uint8Array<ArrayBuffer>], { type: clip.mimeType }),
      'voice',
    );
    const language = options.languageHint
      ? LANGUAGE[options.languageHint]
      : undefined;
    if (language) form.set('language_code', language);
    for (const term of this.options.keyterms ?? [])
      form.append('keyterms', term);

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: 'POST',
        headers: { 'xi-api-key': this.options.apiKey },
        body: form,
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
    const text = parsed.data.text.replace(/\s+/gu, ' ').trim();
    if (!text) return { ok: false, code: 'UNINTELLIGIBLE' };
    return {
      ok: true,
      text,
      ...(parsed.data.language_code
        ? { language: parsed.data.language_code }
        : {}),
      billedSeconds: Math.ceil(clip.durationSeconds),
    };
  }
}
