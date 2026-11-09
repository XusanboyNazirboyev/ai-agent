import { GoogleGenAI } from '@google/genai';
import type {
  AudioClip,
  SpeechToText,
  TranscriptionPricing,
  TranscriptionResult,
  TranscriptionUsage,
} from '../core/speech/speech-to-text.js';

/**
 * Speech-to-text with Gemini's transcription model (ADR 042; owner chose
 * Gemini, 2026-11-07). Official docs read 2026-11-07:
 * - https://aistudio.google.com/docs/transcribe.md: model
 *   `gemini-3.5-transcribe` through the Interactions API; Uzbek is listed
 *   (`uz-UZ`); OGG and Opus are accepted; `generation_config.
 *   transcription_config` takes `language_codes` (empty = auto-detect),
 *   `custom_vocabulary` (best up to about 100 terms) and `mode`; the
 *   transcript is `output_text` in the SDKs.
 * - https://aistudio.google.com/docs/pricing.md: about $0.005 per minute on
 *   the paid tier; the paid tier does not use content to improve products.
 * - SDK `@google/genai` 2.32.0 types: `interactions.create({ model, input:
 *   [{ type: 'audio', data, mime_type }], generation_config })`, request
 *   options `timeout_ms` and `fetch_options.signal`.
 * The provider reports no confidence, so none is returned (the voice policy
 * then treats the transcript as unconfirmed). Audio is sent only after
 * `checkClip` passed; nothing about it is logged.
 */

/** The one SDK call this adapter makes, injectable for tests. */
export interface TranscribeCall {
  (
    params: {
      model: string;
      input: { type: 'audio'; data: string; mime_type: string }[];
      generation_config: {
        transcription_config: {
          language_codes: string[];
          custom_vocabulary?: string[];
        };
      };
    },
    options: { timeout_ms: number; fetch_options?: { signal?: AbortSignal } },
  ): Promise<TranscribeAnswer>;
}

/** The fields of the SDK `Interaction` this adapter reads. */
export interface TranscribeAnswer {
  id?: string | undefined;
  output_text?: string | undefined;
  usage?:
    | {
        total_input_tokens?: number | undefined;
        total_output_tokens?: number | undefined;
        total_thought_tokens?: number | undefined;
      }
    | undefined;
}

/**
 * https://aistudio.google.com/docs/pricing.md, read 2026-11-09, paid tier of
 * `gemini-3.5-transcribe`: input (audio) $2.00 and output (text, including
 * thinking tokens) $12.00 per 1M tokens (the page's per-minute figures are
 * estimates from 25 audio tokens per second).
 */
export const GEMINI_TRANSCRIBE_PRICING: TranscriptionPricing = {
  version: 'gemini-3.5-transcribe@2026-11-09',
  inputNanoPerToken: 2_000,
  outputNanoPerToken: 12_000,
};

/** Reported usage; output and thought tokens are both billed as output. */
function usageOf(answer: TranscribeAnswer): TranscriptionUsage | undefined {
  const usage = answer.usage;
  if (usage?.total_input_tokens === undefined) return undefined;
  return {
    inputTokens: usage.total_input_tokens,
    outputTokens:
      (usage.total_output_tokens ?? 0) + (usage.total_thought_tokens ?? 0),
  };
}

export function sdkTranscribeCall(apiKey: string): TranscribeCall {
  const client = new GoogleGenAI({ apiKey });
  return (params, options) =>
    client.interactions.create(
      { ...params, model: params.model as 'gemini-3.5-transcribe' },
      options,
    );
}

/** BCP-47 codes the model lists, from our locale ids. */
const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  'uz-Latn': 'uz-UZ',
  'uz-Cyrl': 'uz-UZ',
  ru: 'ru-RU',
  en: 'en-US',
};

export class GeminiSpeechToText implements SpeechToText {
  readonly providerId = 'gemini';
  readonly pricing = GEMINI_TRANSCRIBE_PRICING;

  constructor(
    private readonly call: TranscribeCall,
    readonly model = 'gemini-3.5-transcribe',
    private readonly timeoutMs = 20_000,
    /** Tenant words (course names, places) that improve recognition. */
    private readonly vocabulary: readonly string[] = [],
  ) {}

  async transcribe(
    clip: AudioClip,
    options: { languageHint?: string; signal?: AbortSignal } = {},
  ): Promise<TranscriptionResult> {
    const hinted = options.languageHint
      ? LANGUAGE_CODES[options.languageHint]
      : undefined;
    // Uzbek speakers mix in Russian: offer both unless a hint narrows it.
    const languageCodes = hinted
      ? [...new Set([hinted, 'uz-UZ', 'ru-RU'])]
      : ['uz-UZ', 'ru-RU', 'en-US'];
    let answer: TranscribeAnswer;
    try {
      answer = await this.call(
        {
          model: this.model,
          input: [
            {
              type: 'audio',
              data: Buffer.from(clip.data).toString('base64'),
              mime_type: clip.mimeType,
            },
          ],
          generation_config: {
            transcription_config: {
              language_codes: languageCodes,
              ...(this.vocabulary.length > 0
                ? { custom_vocabulary: this.vocabulary.slice(0, 100) }
                : {}),
            },
          },
        },
        {
          timeout_ms: this.timeoutMs,
          ...(options.signal
            ? { fetch_options: { signal: options.signal } }
            : {}),
        },
      );
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      return {
        ok: false,
        code:
          name === 'AbortError' || /timeout/iu.test(String(name ?? ''))
            ? 'TIMEOUT'
            : 'PROVIDER_ERROR',
      };
    }
    const usage = usageOf(answer);
    const billing = {
      ...(usage ? { usage } : {}),
      ...(answer.id ? { responseId: answer.id } : {}),
    };
    const text = (answer.output_text ?? '').replace(/\s+/gu, ' ').trim();
    if (!text) return { ok: false, code: 'UNINTELLIGIBLE', ...billing };
    return {
      ok: true,
      text,
      billedSeconds: Math.ceil(clip.durationSeconds),
      ...billing,
    };
  }
}
