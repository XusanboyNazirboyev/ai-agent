/**
 * VoxCPM2 text-to-speech through the vLLM-Omni OpenAI-compatible endpoint
 * (ADR 055).
 *
 * Documented (read 2026-11-12): https://github.com/OpenBMB/VoxCPM README and
 * https://github.com/vllm-project/vllm-omni/tree/main/examples/online_serving/voxcpm2
 * `vllm serve openbmb/VoxCPM2 --omni --port 8000`, then
 * `POST /v1/audio/speech` with JSON `{"model","input","voice"}`; the response
 * is audio.
 *
 * UNVERIFIED against a real server (verify in S3): the response container and
 * sample rate (the model table says 48 kHz), the authorisation header scheme
 * (`Authorization: Bearer`, the vLLM `--api-key` convention), whether a
 * `response_format` field exists, and real-time factor. The adapter therefore
 * accepts any `audio/*` response, parses WAV (RIFF) for rate and duration, and
 * leaves both null for other containers.
 *
 * No language field is sent (text needs no tag) and the endpoint documents no
 * reference-audio or voice-description field. In the Python API a voice
 * description is written in parentheses at the start of the text, so reply
 * text that begins with a parenthesis could steer the voice: the sanitiser
 * removes it. The text and the audio are never logged and never put into an
 * error message.
 */
import {
  languagePrefix,
  type SpeechAudio,
  type SynthesizeInput,
  type TextToSpeech,
  TtsError,
} from './ports.js';
import { parseWav } from './wav.js';

export const VOXCPM_SUPPORTED_LANGUAGES: readonly string[] = ['ru', 'en'];
export const VOXCPM_DEFAULT_MODEL = 'openbmb/VoxCPM2';
export const VOXCPM_DEFAULT_VOICE = 'default';
export const TTS_DEFAULT_MAX_CHARS = 600;

export interface VoxCpmOptions {
  /** e.g. `http://gpu-host:8000` (no path). */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly voice?: string;
  readonly timeoutMs?: number;
  readonly maxChars?: number;
  readonly fetchImpl?: typeof fetch;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f​-‏ -‮⁠-⁤﻿]/gu;
const OPENING = new Set(['(', '（']);
const CLOSING = new Set([')', '）']);

/** Removes control characters and leading parenthesised groups; collapses whitespace. */
export function sanitizeSpeechText(raw: string): string {
  let text = raw
    .replace(/[\t\n\r  ]+/gu, ' ')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  for (;;) {
    const first = text[0];
    if (first === undefined || !OPENING.has(first)) break;
    let depth = 0;
    let end = -1;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i] as string;
      if (OPENING.has(char)) depth += 1;
      else if (CLOSING.has(char)) {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    // An unclosed group: drop only the opening character.
    text = text.slice(end === -1 ? 1 : end + 1).trimStart();
  }
  return text.trim();
}

export class VoxCpmTextToSpeech implements TextToSpeech {
  readonly provider = 'voxcpm';
  private readonly endpoint: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly timeoutMs: number;
  private readonly maxChars: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: VoxCpmOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/v1/audio/speech`;
    this.model = options.model ?? VOXCPM_DEFAULT_MODEL;
    this.voice = options.voice ?? VOXCPM_DEFAULT_VOICE;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxChars = options.maxChars ?? TTS_DEFAULT_MAX_CHARS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supportsLanguage(language: string): boolean {
    return VOXCPM_SUPPORTED_LANGUAGES.includes(languagePrefix(language));
  }

  async synthesize(input: SynthesizeInput): Promise<SpeechAudio> {
    if (!this.supportsLanguage(input.language)) {
      throw new TtsError(
        'UNSUPPORTED_LANGUAGE',
        'VoxCPM TTS supports only ru and en',
      );
    }
    const text = sanitizeSpeechText(input.text);
    if (text.length === 0) {
      throw new TtsError('EMPTY_TEXT', 'nothing to speak after sanitising');
    }
    if (text.length > this.maxChars) {
      throw new TtsError(
        'TEXT_TOO_LONG',
        `text is longer than ${this.maxChars} characters`,
      );
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    let response: Response;
    let bytes: Uint8Array;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice: this.voice,
        }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new TtsError(
          'PROVIDER_UNAVAILABLE',
          `TTS provider answered HTTP ${response.status}`,
        );
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof TtsError) throw error;
      if (signal.aborted) {
        throw new TtsError('TIMEOUT', 'TTS request timed out or was aborted');
      }
      throw new TtsError('PROVIDER_UNAVAILABLE', 'TTS provider unreachable');
    }
    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();
    if (bytes.length === 0) {
      throw new TtsError('EMPTY_AUDIO', 'TTS provider returned no audio');
    }
    if (!contentType?.startsWith('audio/')) {
      throw new TtsError(
        'INVALID_RESPONSE',
        'TTS provider response is not audio',
      );
    }
    const wav = parseWav(bytes);
    return {
      bytes,
      mimeType: contentType,
      sampleRateHz: wav?.sampleRateHz ?? null,
      durationMs: wav?.durationMs ?? null,
    };
  }
}
