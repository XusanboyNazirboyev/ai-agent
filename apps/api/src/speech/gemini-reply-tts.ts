import { GoogleGenAI } from '@google/genai';
import type { ReplyTts } from './elevenlabs-reply-tts.js';
import { encodeWavToOggOpus } from './ogg-opus-encoder.js';

/**
 * Voice replies spoken by Gemini TTS (owner 2026-11-21). Docs read
 * 2026-11-21: https://ai.google.dev/gemini-api/docs/speech-generation
 * (`interactions.create` with `response_format: {type: 'audio'}` and
 * `generation_config.speech_config: [{voice}]`; a unary answer is a WAV in
 * `output_audio.data`, base64; the input language is detected, Northern Uzbek
 * included) and https://ai.google.dev/gemini-api/docs/pricing
 * (`gemini-3.8-flash-lite-tts`: $0.0015 per 10 s of audio in 2026; the paid
 * tier does not use content to improve products, so the paid key is used).
 * The WAV becomes OGG/Opus for Telegram. Null on any failure.
 */
export type TtsCall = (
  params: Record<string, unknown>,
  options: { timeout_ms: number },
) => Promise<{ output_audio?: { data?: string } | undefined }>;

export function sdkTtsCall(apiKey: string): TtsCall {
  const client = new GoogleGenAI({ apiKey });
  return (params, options) =>
    (
      client.interactions.create as unknown as (
        p: Record<string, unknown>,
        o: { timeout_ms: number },
      ) => Promise<{ output_audio?: { data?: string } }>
    )(params, options);
}

const MAX_TEXT = 2_000;

export class GeminiReplyTts implements ReplyTts {
  constructor(
    private readonly options: {
      readonly call: TtsCall;
      readonly model: string;
      readonly voice: string;
      readonly timeoutMs?: number;
      readonly encode?: (wav: Uint8Array) => Promise<Uint8Array | null>;
    },
  ) {}

  async synthesize(text: string): Promise<Uint8Array | null> {
    if (text.trim().length === 0 || text.length > MAX_TEXT) return null;
    try {
      const answer = await this.options.call(
        {
          model: this.options.model,
          input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: this.options.voice }] },
        },
        { timeout_ms: this.options.timeoutMs ?? 20_000 },
      );
      const data = answer.output_audio?.data;
      if (!data) return null;
      const wav = new Uint8Array(Buffer.from(data, 'base64'));
      return await (this.options.encode ?? encodeWavToOggOpus)(wav);
    } catch {
      return null;
    }
  }
}

/** The first engine that produces audio: Gemini, then ElevenLabs. */
export class FirstReplyTts implements ReplyTts {
  constructor(private readonly engines: readonly ReplyTts[]) {}

  async synthesize(
    text: string,
    languageCode?: string,
  ): Promise<Uint8Array | null> {
    for (const engine of this.engines) {
      const audio = await engine.synthesize(text, languageCode);
      if (audio) return audio;
    }
    return null;
  }
}
