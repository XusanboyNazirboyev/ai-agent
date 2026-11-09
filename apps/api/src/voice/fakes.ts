/**
 * Deterministic in-process fakes for the voice ports: STT, TTS, a mock SIP
 * endpoint and a WebRTC-test-client equivalent. No network, no real sleeps:
 * all waiting goes through the injected Clock.
 */
import {
  TelephonyError,
  type AudioFrame,
  type AudioSendReceipt,
  type CallDirection,
  type CallEvent,
  type CallLeg,
  type Clock,
  type PlaybackRequest,
  type PlaybackResult,
  type RecordingPutInput,
  type RecordingPutResult,
  type ResponderEvent,
  type SttSession,
  type SttSessionOptions,
  type StreamingSpeechToText,
  type StreamingTextToSpeech,
  type TelephonyFailure,
  type TelephonyGateway,
  type CallRecordingStore,
  type TranscriptEvent,
  type TtsAudioChunk,
  type TtsSession,
  type TtsSessionOptions,
  type TurnInput,
  type TurnResponder,
  type Unsubscribe,
} from './ports.js';
import { canPlayRecording, recordingRetainUntil } from './policies.js';

/** Small deterministic PRNG (mulberry32) for repeatable latency jitter. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LatencyKnob {
  readonly baseMs: number;
  readonly jitterMs?: number;
}

function sample(knob: LatencyKnob, rand: () => number): number {
  return knob.baseMs + Math.floor(rand() * (knob.jitterMs ?? 0));
}

// ---------------------------------------------------------------- STT

export interface FakeSttOptions {
  readonly clock: Clock;
  /** Delay from end of utterance to the final transcript. */
  readonly finalLatency?: LatencyKnob;
  /** Delay from first speech frame to the first partial. */
  readonly partialLatencyMs?: number;
  /** Used when a frame carries no hint, in order. */
  readonly transcripts?: readonly string[];
  readonly seed?: number;
}

export class FakeStreamingSpeechToText implements StreamingSpeechToText {
  readonly provider = 'fake-stt';
  readonly sessions: FakeSttSession[] = [];

  constructor(private readonly options: FakeSttOptions) {}

  open(options: SttSessionOptions): Promise<SttSession> {
    const s = new FakeSttSession(this.options, options);
    this.sessions.push(s);
    return Promise.resolve(s);
  }
}

export class FakeSttSession implements SttSession {
  private readonly handlers = new Set<(e: TranscriptEvent) => void>();
  private readonly rand: () => number;
  private closed = false;
  private scriptIndex = 0;
  private utteranceStartMs: number | undefined;
  private utteranceHint: string | undefined;
  private partialSent = false;
  readonly framesReceived: AudioFrame[] = [];

  constructor(
    private readonly options: FakeSttOptions,
    readonly sessionOptions: SttSessionOptions,
  ) {
    this.rand = seededRandom(options.seed ?? 1);
  }

  onTranscript(handler: (event: TranscriptEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  pushAudio(frame: AudioFrame): void {
    if (this.closed) return;
    this.framesReceived.push(frame);
    if (frame.speech) {
      if (this.utteranceStartMs === undefined) {
        this.utteranceStartMs = frame.timestampMs;
        this.partialSent = false;
      }
      if (frame.hint !== undefined) this.utteranceHint = frame.hint;
      if (!this.partialSent) {
        this.partialSent = true;
        void this.emitPartial(frame);
      }
    }
    if (frame.endOfUtterance && this.utteranceStartMs !== undefined) {
      const startMs = this.utteranceStartMs;
      const endMs = frame.timestampMs + frame.durationMs;
      const text = this.utteranceHint ?? this.nextScripted();
      this.utteranceStartMs = undefined;
      this.utteranceHint = undefined;
      void this.emitFinal(text, startMs, endMs);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }

  private nextScripted(): string {
    const list = this.options.transcripts ?? [];
    const text = list[this.scriptIndex] ?? '';
    this.scriptIndex += 1;
    return text;
  }

  private async emitPartial(frame: AudioFrame): Promise<void> {
    await this.options.clock.sleep(this.options.partialLatencyMs ?? 80);
    const text = (frame.hint ?? '').split(' ')[0] ?? '';
    this.emit({
      kind: 'partial',
      text,
      startMs: frame.timestampMs,
      endMs: frame.timestampMs + frame.durationMs,
      emittedAtMs: this.options.clock.now(),
    });
  }

  private async emitFinal(
    text: string,
    startMs: number,
    endMs: number,
  ): Promise<void> {
    await this.options.clock.sleep(
      sample(this.options.finalLatency ?? { baseMs: 150 }, this.rand),
    );
    this.emit({
      kind: 'final',
      text,
      startMs,
      endMs,
      emittedAtMs: this.options.clock.now(),
    });
  }

  private emit(event: TranscriptEvent): void {
    if (this.closed) return;
    for (const h of this.handlers) h(event);
  }
}

// ---------------------------------------------------------------- TTS

export interface FakeTtsOptions {
  readonly clock: Clock;
  /** Delay before the first audio chunk of a sentence. */
  readonly firstByteLatency?: LatencyKnob;
  readonly chunkIntervalMs?: number;
  readonly chunkAudioMs?: number;
  /** Audio duration per character of text. */
  readonly msPerChar?: number;
  readonly seed?: number;
}

export class FakeStreamingTextToSpeech implements StreamingTextToSpeech {
  readonly provider = 'fake-tts';
  readonly sessions: FakeTtsSession[] = [];

  constructor(private readonly options: FakeTtsOptions) {}

  open(options: TtsSessionOptions): Promise<TtsSession> {
    const s = new FakeTtsSession(this.options, options);
    this.sessions.push(s);
    return Promise.resolve(s);
  }
}

export class FakeTtsSession implements TtsSession {
  private readonly rand: () => number;
  private sentenceIndex = 0;
  private cancelEpoch = 0;
  readonly spoken: string[] = [];
  cancelCount = 0;

  constructor(
    private readonly options: FakeTtsOptions,
    readonly sessionOptions: TtsSessionOptions,
  ) {
    this.rand = seededRandom(options.seed ?? 2);
  }

  cancel(): void {
    this.cancelEpoch += 1;
    this.cancelCount += 1;
  }

  async close(): Promise<void> {
    this.cancel();
  }

  async *speak(sentence: string): AsyncIterable<TtsAudioChunk> {
    const epoch = this.cancelEpoch;
    const index = this.sentenceIndex++;
    const { clock } = this.options;
    const chunkAudioMs = this.options.chunkAudioMs ?? 100;
    const total = Math.max(
      chunkAudioMs,
      sentence.length * (this.options.msPerChar ?? 55),
    );
    const count = Math.ceil(total / chunkAudioMs);
    await clock.sleep(
      sample(this.options.firstByteLatency ?? { baseMs: 120 }, this.rand),
    );
    for (let i = 0; i < count; i += 1) {
      if (epoch !== this.cancelEpoch) return;
      if (i === 0) this.spoken.push(sentence);
      yield {
        data: new Uint8Array(8),
        sentenceIndex: index,
        firstOfSentence: i === 0,
        lastOfSentence: i === count - 1,
        durationMs: chunkAudioMs,
        emittedAtMs: clock.now(),
      };
      if (i < count - 1) await clock.sleep(this.options.chunkIntervalMs ?? 40);
    }
  }
}

// ---------------------------------------------------------------- responder

export interface FakeResponderOptions {
  readonly clock: Clock;
  readonly answer?: string;
  readonly firstTokenLatency?: LatencyKnob;
  /** Delay between streamed words. */
  readonly tokenIntervalMs?: number;
  readonly seed?: number;
  /** Turn indexes (0-based) on which the responder asks for a handover. */
  readonly handoverOnTurns?: readonly number[];
}

export const CANNED_ANSWER =
  'Albatta, yordam beraman. Kursimiz dushanba kuni boshlanadi. Batafsil ma’lumotni operator aytib beradi.';

/** Streams a canned answer word by word, like an LLM token stream. */
export class FakeStreamingResponder implements TurnResponder {
  private readonly rand: () => number;

  constructor(private readonly options: FakeResponderOptions) {
    this.rand = seededRandom(options.seed ?? 3);
  }

  async *respond(
    input: TurnInput,
    signal: AbortSignal,
  ): AsyncIterable<ResponderEvent> {
    const { clock } = this.options;
    await clock.sleep(
      sample(this.options.firstTokenLatency ?? { baseMs: 350 }, this.rand),
    );
    if (this.options.handoverOnTurns?.includes(input.turnIndex)) {
      yield { type: 'handover', reason: 'CUSTOMER_REQUEST' };
      return;
    }
    const words = (this.options.answer ?? CANNED_ANSWER).split(' ');
    for (let i = 0; i < words.length; i += 1) {
      if (signal.aborted) return;
      yield { type: 'text', text: i === 0 ? words[i] : ` ${words[i]}` };
      if (i < words.length - 1) {
        await clock.sleep(this.options.tokenIntervalMs ?? 30);
      }
    }
  }
}

// ---------------------------------------------------------------- mock SIP

export type SipOperation = 'accept' | 'place' | 'transfer' | 'hangup';

export interface MockSipOptions {
  readonly clock: Clock;
  /** Network delay from sendAudio to the far end hearing it. */
  readonly playoutLatencyMs?: number;
}

/** Caller-side view of a mock call; used by the WebRTC test client. */
export interface MockCallEndpoint {
  readonly callId: string;
  /** Deliver a caller frame to the agent. */
  deliverFrame(frame: AudioFrame): void;
  /** Audio the agent sent, with the far-end playback time. */
  readonly received: { chunk: TtsAudioChunk; playbackStartMs: number }[];
  readonly clearCount: () => number;
  hangUpFromCaller(): void;
}

class MockLeg implements CallLeg {
  readonly frameHandlers = new Set<(f: AudioFrame) => void>();
  readonly received: { chunk: TtsAudioChunk; playbackStartMs: number }[] = [];
  clears = 0;

  constructor(
    readonly callId: string,
    readonly direction: CallDirection,
    readonly remoteNumber: string,
    private readonly clock: Clock,
    private readonly playoutLatencyMs: number,
  ) {}

  onAudio(handler: (frame: AudioFrame) => void): Unsubscribe {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  sendAudio(chunk: TtsAudioChunk): AudioSendReceipt {
    const playbackStartMs = this.clock.now() + this.playoutLatencyMs;
    this.received.push({ chunk, playbackStartMs });
    return { playbackStartMs };
  }

  clearPlayback(): void {
    this.clears += 1;
  }
}

export class MockSipGateway implements TelephonyGateway {
  private readonly handlers = new Set<(e: CallEvent) => void>();
  private readonly legs = new Map<string, MockLeg>();
  private readonly pending = new Map<
    string,
    { from: string; to: string; direction: CallDirection }
  >();
  private readonly failures = new Map<SipOperation, string[]>();
  private seq = 0;
  readonly transfers: { callId: string; toNumber: string }[] = [];
  readonly hangUps: { callId: string; reason: string }[] = [];
  readonly outboundPlaced: { to: string; from?: string }[] = [];

  constructor(private readonly options: MockSipOptions) {}

  onCallEvent(handler: (event: CallEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** The next call to `operation` throws a TelephonyError with `message`. */
  injectFailure(operation: SipOperation, message = 'injected failure'): void {
    const list = this.failures.get(operation) ?? [];
    list.push(message);
    this.failures.set(operation, list);
  }

  /** Simulate a carrier INVITE; emits an 'incoming' event. */
  simulateInbound(from: string, to: string): string {
    const callId = `call-${++this.seq}`;
    this.pending.set(callId, { from, to, direction: 'INBOUND' });
    this.emit({ type: 'incoming', callId, from, to });
    return callId;
  }

  acceptInbound(callId: string): Promise<CallLeg> {
    return this.attempt('accept', 'ACCEPT_FAILED', () => {
      const call = this.pending.get(callId);
      if (!call) throw new TelephonyError('ACCEPT_FAILED', 'unknown call');
      this.pending.delete(callId);
      const leg = this.createLeg(callId, 'INBOUND', call.from);
      this.emit({ type: 'answered', callId });
      return leg;
    });
  }

  placeOutbound(options: { to: string; from?: string }): Promise<CallLeg> {
    return this.attempt('place', 'PLACE_FAILED', () => {
      this.outboundPlaced.push(options);
      const callId = `call-${++this.seq}`;
      const leg = this.createLeg(callId, 'OUTBOUND', options.to);
      this.emit({ type: 'answered', callId });
      return leg;
    });
  }

  transfer(callId: string, toNumber: string): Promise<void> {
    return this.attempt('transfer', 'TRANSFER_FAILED', () => {
      this.transfers.push({ callId, toNumber });
      this.emit({ type: 'transferred', callId, toNumber });
      this.finish(callId, 'transferred');
    });
  }

  hangUp(callId: string, reason: string): Promise<void> {
    return this.attempt('hangup', 'HANGUP_FAILED', () => {
      this.hangUps.push({ callId, reason });
      this.finish(callId, reason);
    });
  }

  /** Caller-side handle for the test client. */
  endpoint(callId: string): MockCallEndpoint {
    const leg = this.legs.get(callId);
    if (!leg) throw new Error(`no active leg ${callId}`);
    return {
      callId,
      deliverFrame: (frame): void => {
        for (const h of [...leg.frameHandlers]) h(frame);
      },
      received: leg.received,
      clearCount: () => leg.clears,
      hangUpFromCaller: () => this.finish(callId, 'caller_hangup'),
    };
  }

  private createLeg(
    callId: string,
    direction: CallDirection,
    remote: string,
  ): MockLeg {
    const leg = new MockLeg(
      callId,
      direction,
      remote,
      this.options.clock,
      this.options.playoutLatencyMs ?? 40,
    );
    this.legs.set(callId, leg);
    return leg;
  }

  private finish(callId: string, reason: string): void {
    if (!this.legs.has(callId)) return;
    this.emit({ type: 'ended', callId, reason });
  }

  private attempt<T>(
    op: SipOperation,
    failure: TelephonyFailure,
    run: () => T,
  ): Promise<T> {
    const message = this.failures.get(op)?.shift();
    if (message !== undefined) {
      return Promise.reject(new TelephonyError(failure, message));
    }
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private emit(event: CallEvent): void {
    for (const h of [...this.handlers]) h(event);
  }
}

// ---------------------------------------------------------------- caller

export interface HeardAudio {
  readonly atMs: number;
  readonly sentenceIndex: number;
  readonly firstOfSentence: boolean;
  readonly durationMs: number;
}

/**
 * WebRTC-test-client equivalent: speaks scripted utterances as fake audio
 * frames into a call and records everything it hears with timestamps.
 */
export class ScriptedCaller {
  private lastHeardCount = 0;

  constructor(
    private readonly clock: Clock,
    private readonly endpoint: MockCallEndpoint,
    private readonly frameMs = 100,
  ) {}

  /** Audio the caller heard so far, at far-end playback times. */
  heard(): HeardAudio[] {
    return this.endpoint.received.map((r) => ({
      atMs: r.playbackStartMs,
      sentenceIndex: r.chunk.sentenceIndex,
      firstOfSentence: r.chunk.firstOfSentence,
      durationMs: r.chunk.durationMs,
    }));
  }

  /** Speaks `speechMs` of audio carrying `text`, then goes silent. */
  async say(text: string, speechMs = 600): Promise<{ endOfSpeechMs: number }> {
    const frames = Math.max(1, Math.round(speechMs / this.frameMs));
    for (let i = 0; i < frames; i += 1) {
      this.endpoint.deliverFrame({
        data: new Uint8Array(4),
        timestampMs: this.clock.now(),
        durationMs: this.frameMs,
        speech: true,
        hint: i === 0 ? text : undefined,
      });
      await this.clock.sleep(this.frameMs);
    }
    const endOfSpeechMs = this.clock.now();
    this.endpoint.deliverFrame({
      data: new Uint8Array(4),
      timestampMs: endOfSpeechMs,
      durationMs: this.frameMs,
      speech: false,
      endOfUtterance: true,
    });
    return { endOfSpeechMs };
  }

  /** Keeps speaking over the agent (barge-in) without ending the utterance. */
  async interrupt(text: string, speechMs = 300): Promise<void> {
    await this.say(text, speechMs);
  }

  /**
   * Waits (virtual time) for new agent audio and until the stream has been
   * quiet for `quietMs`, or `timeoutMs` passes. Returns audio heard since the
   * previous call.
   */
  async waitForReply(quietMs = 400, timeoutMs = 20000): Promise<HeardAudio[]> {
    const start = this.clock.now();
    let lastCount = this.endpoint.received.length;
    let lastChange = this.clock.now();
    while (this.clock.now() - start < timeoutMs) {
      await this.clock.sleep(20);
      const count = this.endpoint.received.length;
      if (count !== lastCount) {
        lastCount = count;
        lastChange = this.clock.now();
      } else if (
        count > this.lastHeardCount &&
        this.clock.now() - lastChange >= quietMs
      ) {
        break;
      }
    }
    const all = this.heard();
    const fresh = all.slice(this.lastHeardCount);
    this.lastHeardCount = all.length;
    return fresh;
  }

  hangUp(): void {
    this.endpoint.hangUpFromCaller();
  }
}

// ---------------------------------------------------------------- recording

/** In-memory CallRecordingStore with the role rule of policies.ts. */
export class InMemoryRecordingStore implements CallRecordingStore {
  private readonly items = new Map<
    string,
    { tenantId: string; retainUntil: Date }
  >();
  private seq = 0;

  put(input: RecordingPutInput): Promise<RecordingPutResult> {
    const recordingId = `rec-${++this.seq}`;
    const retainUntil = recordingRetainUntil(input.startedAt);
    this.items.set(recordingId, { tenantId: input.tenantId, retainUntil });
    return Promise.resolve({ recordingId, retainUntil });
  }

  createPlaybackUrl(request: PlaybackRequest): Promise<PlaybackResult> {
    const item = this.items.get(request.recordingId);
    if (!item || item.tenantId !== request.tenantId) {
      return Promise.resolve({ ok: false, reason: 'NOT_FOUND' });
    }
    if (!canPlayRecording(request.requester.role)) {
      return Promise.resolve({ ok: false, reason: 'FORBIDDEN' });
    }
    return Promise.resolve({
      ok: true,
      url: `memory://recordings/${request.recordingId}?sig=fake`,
      expiresAt: new Date(Date.now() + request.ttlSeconds * 1000),
    });
  }
}
