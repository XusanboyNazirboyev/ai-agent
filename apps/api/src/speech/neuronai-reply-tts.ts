import type { ReplyTts } from './elevenlabs-reply-tts.js';
import { encodeWavToOggOpus } from './ogg-opus-encoder.js';

/**
 * Voice replies spoken by NeuronAI's native Uzbek voices (owner 2026-11-21:
 * Kamola and Muhriddin). Docs read 2026-11-21:
 * https://docs.neuronai.uz/api/openapi.json (`POST /v1/tts/synthesize` on
 * https://my.neuronai.uz/api, `Authorization: Bearer`, JSON `{text, voice_id,
 * language, quality}`, answer `audio/wav`; 0.3 credits per character, 1
 * credit = 1 UZS per https://docs.neuronai.uz/platform/billing). Only Uzbek
 * (or an unknown language) is spoken here; other languages go to the next
 * engine. The WAV becomes OGG/Opus for Telegram. Null on any failure.
 */
export const NEURONAI_VOICES = [
  'kamola',
  'muhriddin',
  'madina',
  'saodat',
  'kamron',
] as const;

const URL = 'https://my.neuronai.uz/api/v1/tts/synthesize';
const MAX_TEXT = 2_000;

export class NeuronAiReplyTts implements ReplyTts {
  constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly voice: string;
      readonly timeoutMs?: number;
      readonly fetch?: typeof fetch;
      readonly encode?: (wav: Uint8Array) => Promise<Uint8Array | null>;
    },
  ) {}

  async synthesize(
    text: string,
    languageCode?: string,
  ): Promise<Uint8Array | null> {
    if (languageCode && languageCode !== 'uz') return null;
    if (text.trim().length === 0 || text.length > MAX_TEXT) return null;
    try {
      const response = await (this.options.fetch ?? fetch)(URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text,
          voice_id: this.options.voice,
          language: 'uz',
          quality: 'standard',
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
      if (!response.ok) return null;
      const wav = new Uint8Array(await response.arrayBuffer());
      if (wav.length === 0) return null;
      return await (this.options.encode ?? encodeWavToOggOpus)(wav);
    } catch {
      return null;
    }
  }
}
