/**
 * ElevenLabs speech adapters (ADR 045, V1: Uzbek = ElevenLabs).
 *
 * STT: Scribe v2 Realtime over WebSocket.
 *   https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 *   (read 2026-11-09): `wss://api.elevenlabs.io/v1/speech-to-text/realtime`,
 *   header `xi-api-key`, query `model_id`, `audio_format`, `language_code`,
 *   `commit_strategy`; client `input_audio_chunk` {audio_base_64, commit,
 *   sample_rate}; server `partial_transcript` / `committed_transcript` {text}
 *   and error messages carrying `error`.
 * TTS: `eleven_v4_turbo` over the Text to Dialogue WebSocket, the only socket
 *   that accepts v3/v4 models.
 *   https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket and
 *   https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd
 *   (read 2026-11-09): `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input`,
 *   first message `{voices: [id]}`, then `{inputs: [{text, voice_id,
 *   new_turn}], flush}`; server `{audio}` (base64 of `output_format`),
 *   `is_final_audio_for_turn`, `is_final`, errors with `error`; 20 s
 *   inactivity limit, reset by `{keep_alive: true}`.
 * Verified live on 2026-11-09 with the project key: `language_code=uz`,
 * `audio_format=pcm_16000` and `output_format=pcm_16000` are accepted, and a
 * flushed turn ends with `is_final_audio_for_turn`.
 *
 * Audio contract on both sides: PCM signed 16-bit little-endian, 16 kHz, mono
 * (32 bytes per ms). The telephony adapter converts to and from it.
 */
import type { LocaleId } from '../../core/locales/locale-pack.js';
import { AsyncQueue } from '../async-queue.js';
import type {
  AudioFrame,
  Clock,
  StreamingSpeechToText,
  StreamingTextToSpeech,
  SttSession,
  SttSessionOptions,
  TranscriptEvent,
  TtsAudioChunk,
  TtsSession,
  TtsSessionOptions,
  Unsubscribe,
} from '../ports.js';
import {
  type SocketFactory,
  type SocketLike,
  waitForOpen,
  wsSocketFactory,
} from './ws-transport.js';

export const ELEVENLABS_PROVIDER = 'elevenlabs';
export const ELEVENLABS_STT_MODEL = 'scribe_v2_realtime';
export const ELEVENLABS_TTS_MODEL = 'eleven_v4_turbo';
export const PCM_SAMPLE_RATE = 16_000;
/** Bytes per millisecond of PCM s16le mono at 16 kHz. */
export const PCM_BYTES_PER_MS = (PCM_SAMPLE_RATE * 2) / 1000;

/** Language codes sent to ElevenLabs. Script is a separate concern (D17). */
export const ELEVENLABS_LANGUAGE: Readonly<Record<LocaleId, string>> = {
  'uz-Latn': 'uz',
  'uz-Cyrl': 'uz',
  ru: 'ru',
  en: 'en',
};

export interface ElevenLabsOptions {
  readonly apiKey: string;
  readonly clock: Clock;
  /** Default `wss://api.elevenlabs.io`; a regional host may replace it. */
  readonly baseUrl?: string;
  readonly socketFactory?: SocketFactory;
  readonly openTimeoutMs?: number;
}

export class ElevenLabsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ElevenLabsError';
  }
}

function base(options: ElevenLabsOptions): string {
  return (options.baseUrl ?? 'wss://api.elevenlabs.io').replace(/\/+$/u, '');
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Vendor error text is untrusted; keep a short, single-line excerpt. */
function errorText(message: Record<string, unknown>): string {
  const raw =
    typeof message.error === 'string'
      ? message.error
      : typeof message.message === 'string'
        ? message.message
        : 'unknown error';
  return raw.replace(/\s+/gu, ' ').slice(0, 200);
}

// ---------------------------------------------------------------- STT

export type CommitStrategy = 'manual' | 'vad';

export interface ElevenLabsSttOptions extends ElevenLabsOptions {
  /**
   * `manual` (default): the telephony VAD decides the end of an utterance and
   * the frame flagged `endOfUtterance` commits it. `vad`: the server decides.
   */
  readonly commitStrategy?: CommitStrategy;
  /** Domain words that improve recognition (tenant names, products). */
  readonly keyterms?: readonly string[];
}

export class ElevenLabsRealtimeStt implements StreamingSpeechToText {
  readonly provider = ELEVENLABS_PROVIDER;
  readonly model = ELEVENLABS_STT_MODEL;

  constructor(private readonly options: ElevenLabsSttOptions) {}

  async open(options: SttSessionOptions): Promise<ElevenLabsSttSession> {
    const params = new URLSearchParams({
      model_id: ELEVENLABS_STT_MODEL,
      audio_format: 'pcm_16000',
      language_code: ELEVENLABS_LANGUAGE[options.locale],
      commit_strategy: this.options.commitStrategy ?? 'manual',
    });
    for (const term of this.options.keyterms ?? [])
      params.append('keyterms', term);
    const socket = (this.options.socketFactory ?? wsSocketFactory)({
      url: `${base(this.options)}/v1/speech-to-text/realtime?${params.toString()}`,
      headers: { 'xi-api-key': this.options.apiKey },
    });
    const session = new ElevenLabsSttSession(socket, this.options.clock);
    await waitForOpen(socket, this.options.openTimeoutMs ?? 5_000);
    return session;
  }
}

export class ElevenLabsSttSession implements SttSession {
  private readonly handlers = new Set<(event: TranscriptEvent) => void>();
  private utteranceStartMs: number | undefined;
  private lastFrameEndMs = 0;
  private uncommittedAudio = false;
  private closed = false;
  /** Audio sent to the provider, ms (billing basis). */
  audioMsSent = 0;
  failure: ElevenLabsError | undefined;

  constructor(
    private readonly socket: SocketLike,
    private readonly clock: Clock,
  ) {
    socket.onMessage((text) => this.onMessage(text));
    socket.onClose((code, reason, error) => {
      this.closed = true;
      if (code !== 1000 && !this.failure)
        this.failure = new ElevenLabsError(
          'CLOSED',
          error?.message ?? `closed ${code} ${reason.slice(0, 100)}`,
        );
    });
  }

  pushAudio(frame: AudioFrame): void {
    if (this.closed || !this.socket.isOpen) return;
    if (this.utteranceStartMs === undefined && frame.speech)
      this.utteranceStartMs = frame.timestampMs;
    this.lastFrameEndMs = frame.timestampMs + frame.durationMs;
    const hasAudio = this.uncommittedAudio || frame.data.length > 0;
    const commit = frame.endOfUtterance === true && hasAudio;
    if (frame.data.length === 0 && !commit) return;
    this.socket.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from(frame.data).toString('base64'),
        commit,
        sample_rate: PCM_SAMPLE_RATE,
      }),
    );
    this.audioMsSent += frame.durationMs;
    this.uncommittedAudio = !commit;
  }

  onTranscript(handler: (event: TranscriptEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.socket.close(1000, 'call ended');
    }
    return Promise.resolve();
  }

  private onMessage(text: string): void {
    const message = parse(text);
    if (!message) return;
    const type = message.message_type;
    if (type === 'partial_transcript' || type === 'committed_transcript') {
      const final = type === 'committed_transcript';
      const event: TranscriptEvent = {
        kind: final ? 'final' : 'partial',
        text: typeof message.text === 'string' ? message.text : '',
        startMs: this.utteranceStartMs ?? this.lastFrameEndMs,
        endMs: this.lastFrameEndMs,
        emittedAtMs: this.clock.now(),
      };
      if (final) this.utteranceStartMs = undefined;
      for (const handler of this.handlers) handler(event);
      return;
    }
    if (typeof message.error === 'string' && typeof type === 'string') {
      this.failure = new ElevenLabsError(type, errorText(message));
      if (type !== 'commit_throttled')
        this.socket.close(1000, 'provider error');
    }
  }
}

// ---------------------------------------------------------------- TTS

export interface ElevenLabsTtsOptions extends ElevenLabsOptions {
  /** Voice per locale; `TtsSessionOptions.voiceId` overrides it. */
  readonly voices: Readonly<Partial<Record<LocaleId, string>>>;
  readonly keepAliveMs?: number;
}

type TtsItem =
  | { readonly type: 'audio'; readonly data: Uint8Array }
  | { readonly type: 'end' }
  | { readonly type: 'error'; readonly error: ElevenLabsError };

export class ElevenLabsDialogueTts implements StreamingTextToSpeech {
  readonly provider = ELEVENLABS_PROVIDER;
  readonly model = ELEVENLABS_TTS_MODEL;

  constructor(private readonly options: ElevenLabsTtsOptions) {}

  async open(options: TtsSessionOptions): Promise<ElevenLabsTtsSession> {
    const voiceId = options.voiceId ?? this.options.voices[options.locale];
    if (!voiceId)
      throw new ElevenLabsError(
        'NO_VOICE',
        `no ElevenLabs voice configured for ${options.locale}`,
      );
    const session = new ElevenLabsTtsSession(this.options, {
      voiceId,
      language: ELEVENLABS_LANGUAGE[options.locale],
    });
    await session.connect();
    return session;
  }
}

export class ElevenLabsTtsSession implements TtsSession {
  private socket: SocketLike | undefined;
  private ready: Promise<void> | undefined;
  private sink: AsyncQueue<TtsItem> | undefined;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private sentenceIndex = 0;
  private closed = false;
  /** Characters sent for synthesis (billing basis). */
  charactersSent = 0;

  constructor(
    private readonly options: ElevenLabsTtsOptions,
    private readonly voice: { voiceId: string; language: string },
  ) {}

  /** Opens (or re-opens) the socket and registers the voice. */
  connect(): Promise<void> {
    const params = new URLSearchParams({
      model_id: ELEVENLABS_TTS_MODEL,
      output_format: 'pcm_16000',
      language_code: this.voice.language,
    });
    const socket = (this.options.socketFactory ?? wsSocketFactory)({
      url: `${base(this.options)}/v1/text-to-dialogue/stream-input?${params.toString()}`,
      headers: { 'xi-api-key': this.options.apiKey },
    });
    this.socket = socket;
    socket.onMessage((text) => {
      if (this.socket === socket) this.onMessage(text);
    });
    socket.onClose((code, reason, error) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = undefined;
      this.stopKeepAlive();
      this.sink?.push({
        type: 'error',
        error: new ElevenLabsError(
          'CLOSED',
          error?.message ?? `closed ${code} ${reason.slice(0, 100)}`,
        ),
      });
    });
    this.ready = waitForOpen(socket, this.options.openTimeoutMs ?? 5_000).then(
      () => {
        socket.send(JSON.stringify({ voices: [this.voice.voiceId] }));
        this.startKeepAlive();
      },
    );
    return this.ready;
  }

  async *speak(sentence: string): AsyncIterable<TtsAudioChunk> {
    const text = sentence.trim();
    if (text.length === 0 || this.closed) return;
    if (this.sink) throw new Error('speak() called while a sentence is active');
    if (!this.ready) void this.connect().catch(() => undefined);
    const sink = new AsyncQueue<TtsItem>();
    this.sink = sink;
    const index = this.sentenceIndex++;
    try {
      await this.ready;
      this.socket?.send(
        JSON.stringify({
          inputs: [{ text, voice_id: this.voice.voiceId, new_turn: true }],
          flush: true,
        }),
      );
      this.charactersSent += text.length;
      let first = true;
      for (;;) {
        const item = await sink.next();
        if (item.type === 'error') {
          if (this.sink !== sink) return; // cancelled
          throw item.error;
        }
        if (item.type === 'end') {
          if (this.sink !== sink) return; // cancelled: no closing chunk
          yield this.chunk(new Uint8Array(0), index, first, true);
          return;
        }
        yield this.chunk(item.data, index, first, false);
        first = false;
      }
    } finally {
      if (this.sink === sink) this.sink = undefined;
    }
  }

  /** Barge-in: drop the socket (stops generation) and pre-warm a new one. */
  cancel(): void {
    const sink = this.sink;
    this.sink = undefined;
    sink?.push({ type: 'end' });
    const socket = this.socket;
    this.socket = undefined;
    this.ready = undefined;
    this.stopKeepAlive();
    socket?.close(1000, 'barge-in');
    if (!this.closed) void this.connect().catch(() => undefined);
  }

  close(): Promise<void> {
    this.closed = true;
    this.stopKeepAlive();
    const socket = this.socket;
    this.socket = undefined;
    if (socket?.isOpen) socket.send(JSON.stringify({ close_socket: true }));
    socket?.close(1000, 'call ended');
    return Promise.resolve();
  }

  private chunk(
    data: Uint8Array,
    sentenceIndex: number,
    firstOfSentence: boolean,
    lastOfSentence: boolean,
  ): TtsAudioChunk {
    return {
      data,
      sentenceIndex,
      firstOfSentence,
      lastOfSentence,
      durationMs: data.length / PCM_BYTES_PER_MS,
      emittedAtMs: this.options.clock.now(),
    };
  }

  private onMessage(text: string): void {
    const message = parse(text);
    if (!message) return;
    if (typeof message.error === 'string') {
      this.sink?.push({
        type: 'error',
        error: new ElevenLabsError(
          typeof message.code === 'string' ? message.code : message.error,
          errorText(message),
        ),
      });
      return;
    }
    if (typeof message.audio === 'string' && message.audio.length > 0)
      this.sink?.push({
        type: 'audio',
        data: new Uint8Array(Buffer.from(message.audio, 'base64')),
      });
    if (message.is_final_audio_for_turn === true || message.is_final === true)
      this.sink?.push({ type: 'end' });
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAlive = setInterval(() => {
      if (this.socket?.isOpen && !this.sink)
        this.socket.send(JSON.stringify({ keep_alive: true }));
    }, this.options.keepAliveMs ?? 15_000);
    this.keepAlive.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = undefined;
  }
}
