import { z } from 'zod';
import type {
  AudioClip,
  SpeechToText,
  TranscriptionResult,
} from '../core/speech/speech-to-text.js';

/**
 * Speech-to-text over the OpenAI-compatible `POST {baseUrl}/audio/transcriptions`
 * (multipart: `model`, `file`, optional `language` ISO-639-1,
 * `response_format=json`; `Authorization: Bearer`; response `{ text }`).
 * Used for Groq Whisper, docs read 2026-11-09:
 * https://console.groq.com/docs/speech-to-text and
 * https://console.groq.com/docs/api-reference#audio-transcription
 * (models `whisper-large-v3`, `whisper-large-v3-turbo`; ogg accepted; 25 MB
 * on the free tier; at least 10 s billed per request; Uzbek is not listed,
 * so it is measured, not assumed). No confidence is returned; no provider
 * error text is returned or logged. Billed by audio time, so no token
 * pricing: the metering layer keeps the worst case counted.
 */

const LANGUAGE: Readonly<Record<string, string>> = {
  'uz-Latn': 'uz',
  'uz-Cyrl': 'uz',
  uz: 'uz',
  ru: 'ru',
  en: 'en',
};

const EXTENSION: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
};

const ResponseSchema = z.object({ text: z.string() });

export interface WhisperSpeechToTextOptions {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class WhisperSpeechToText implements SpeechToText {
  readonly providerId: string;
  readonly model: string;
  private readonly endpoint: string;
  private readonly request: typeof fetch;

  constructor(private readonly options: WhisperSpeechToTextOptions) {
    this.providerId = options.providerId;
    this.model = options.model;
    this.endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/audio/transcriptions`;
    this.request = options.fetch ?? fetch;
  }

  async transcribe(
    clip: AudioClip,
    options: { languageHint?: string; signal?: AbortSignal } = {},
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    form.set('model', this.model);
    form.set('response_format', 'json');
    const type = clip.mimeType.split(';')[0]!.trim().toLowerCase();
    form.set(
      'file',
      new Blob([clip.data as Uint8Array<ArrayBuffer>], { type }),
      `voice.${EXTENSION[type] ?? 'ogg'}`,
    );
    const language = options.languageHint
      ? LANGUAGE[options.languageHint]
      : undefined;
    if (language) form.set('language', language);

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}` },
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
    return { ok: true, text, billedSeconds: Math.ceil(clip.durationSeconds) };
  }
}
