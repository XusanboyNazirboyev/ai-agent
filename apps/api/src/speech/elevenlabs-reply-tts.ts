import { ELEVENLABS_TTS_MODEL } from '../voice/adapters/elevenlabs.js';

/**
 * Voice replies (owner 2026-11-21): one bot reply as an MP3 file through
 * ElevenLabs `POST /v1/text-to-dialogue` (docs read 2026-11-21:
 * https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert; header
 * `xi-api-key`, query `output_format` (default `mp3_44100_128`), body
 * `inputs: [{text, voice_id}]`, `model_id`, `language_code`; keep the text at
 * or below 2,000 characters). `eleven_v4_turbo` with `language_code: uz` and a
 * premade voice returned an MP3 on the free plan on 2026-11-21; `eleven_v3`
 * refuses `uz`, and library voices need a paid plan. Returns null on any
 * failure (the text reply was already sent); never logs the text or the key.
 */
export interface ReplyTts {
  synthesize(text: string, languageCode?: string): Promise<Uint8Array | null>;
}

const MAX_TEXT = 2_000;
/** Telegram's sendVoice limit (Bot API, read 2026-11-21). */
const MAX_BYTES = 50 * 1024 * 1024;

export class ElevenLabsReplyTts implements ReplyTts {
  constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly voiceId: string;
      readonly timeoutMs?: number;
      readonly fetch?: typeof fetch;
    },
  ) {}

  async synthesize(
    text: string,
    languageCode?: string,
  ): Promise<Uint8Array | null> {
    if (text.trim().length === 0 || text.length > MAX_TEXT) return null;
    try {
      const response = await (this.options.fetch ?? fetch)(
        'https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128',
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.options.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            inputs: [{ text, voice_id: this.options.voiceId }],
            model_id: ELEVENLABS_TTS_MODEL,
            ...(languageCode ? { language_code: languageCode } : {}),
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
        },
      );
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > 0 && bytes.byteLength <= MAX_BYTES
        ? bytes
        : null;
    } catch {
      return null;
    }
  }
}
