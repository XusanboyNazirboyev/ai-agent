import { z } from 'zod';

/**
 * Timed transcript of a recorded call from OvozAI (ADR 085 step 3a):
 * `POST https://api.ovozai.uz/v1/audio/transcriptions` (multipart `model`,
 * `file`, `response_format=verbose_json`; Bearer key). Docs read 2026-11-23:
 * https://api.ovozai.uz/docs.md (500 MB max, two jobs at a time, 429
 * `too_many_jobs`, 502/503 worth a retry; audio deleted after processing).
 * The segment shape follows the OpenAI verbose_json form (`start`, `end`,
 * `text` in seconds); unverified on a real call, so it is parsed leniently and
 * a reply with only `text` becomes one segment. No provider text is returned
 * or logged.
 */
export const OVOZAI_TRANSCRIPTIONS_URL =
  'https://api.ovozai.uz/v1/audio/transcriptions';

export interface CallSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type CallTranscription =
  | { readonly ok: true; readonly segments: readonly CallSegment[] }
  | {
      readonly ok: false;
      /** BUSY: 429 or 502/503, worth a later retry; EMPTY: nothing heard. */
      readonly code: 'BUSY' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'EMPTY';
    };

export interface CallTranscriber {
  transcribe(audio: Uint8Array, mimeType: string): Promise<CallTranscription>;
}

const Segment = z.object({
  start: z.coerce.number().finite().nonnegative(),
  end: z.coerce.number().finite().nonnegative(),
  text: z.string(),
});
const Reply = z.object({
  text: z.string().optional(),
  segments: z.array(z.unknown()).optional(),
  duration: z.coerce.number().optional(),
});

const EXTENSION: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
};

/** Pure: verbose_json body to clean segments (exported for tests). */
export function parseVerboseJson(body: unknown): CallSegment[] {
  const reply = Reply.safeParse(body);
  if (!reply.success) return [];
  const segments: CallSegment[] = [];
  for (const raw of reply.data.segments ?? []) {
    const segment = Segment.safeParse(raw);
    if (!segment.success) continue;
    const text = segment.data.text.replace(/\s+/gu, ' ').trim();
    if (text)
      segments.push({
        start: segment.data.start,
        end: Math.max(segment.data.start, segment.data.end),
        text,
      });
  }
  if (segments.length > 0) return segments;
  const text = reply.data.text?.replace(/\s+/gu, ' ').trim();
  return text ? [{ start: 0, end: reply.data.duration ?? 0, text }] : [];
}

export class OvozAiCallTranscriber implements CallTranscriber {
  private readonly request: typeof fetch;

  constructor(
    private readonly options: {
      readonly apiKey: string;
      /** A long call takes a while; the claim lease is longer than this. */
      readonly timeoutMs?: number;
      readonly fetch?: typeof fetch;
    },
  ) {
    this.request = options.fetch ?? fetch;
  }

  async transcribe(
    audio: Uint8Array,
    mimeType: string,
  ): Promise<CallTranscription> {
    const type = mimeType.split(';')[0]!.trim().toLowerCase();
    const form = new FormData();
    form.set('model', 'ovozai-transcribe');
    form.set('response_format', 'verbose_json');
    form.set(
      'file',
      new Blob([audio as Uint8Array<ArrayBuffer>], { type }),
      `call.${EXTENSION[type] ?? 'mp3'}`,
    );
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 8 * 60_000);
    let response: Response;
    try {
      response = await this.request(OVOZAI_TRANSCRIPTIONS_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: timeout,
      });
    } catch {
      return {
        ok: false,
        code: timeout.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR',
      };
    }
    if ([429, 502, 503].includes(response.status))
      return { ok: false, code: 'BUSY' };
    if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR' };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, code: 'PROVIDER_ERROR' };
    }
    const segments = parseVerboseJson(body);
    return segments.length > 0
      ? { ok: true, segments }
      : { ok: false, code: 'EMPTY' };
  }
}
