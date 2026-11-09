/**
 * Voice-call ports (ADR 045). Provider-neutral and streaming. No vendor SDK,
 * client or network call lives here: provider and model ids are plain config
 * strings, and real adapters implement these interfaces later.
 */
import type { LocaleId } from '../core/locales/locale-pack.js';

export type Unsubscribe = () => void;

/** Time source. Production uses the system clock; tests use a virtual one. */
export interface Clock {
  /** Milliseconds on a monotonic scale (origin is irrelevant). */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface AudioFrame {
  readonly data: Uint8Array;
  /** Capture time on the call clock, ms. */
  readonly timestampMs: number;
  readonly durationMs: number;
  /** Voice-activity flag of the sender (false = silence). */
  readonly speech: boolean;
  /** Last frame of an utterance: the caller stopped speaking. */
  readonly endOfUtterance?: boolean;
  /** Fake adapters only: the words the frame "contains". Real audio has none. */
  readonly hint?: string;
}

export interface TranscriptEvent {
  readonly kind: 'partial' | 'final';
  readonly text: string;
  /** Audio time span the transcript covers, ms on the call clock. */
  readonly startMs: number;
  readonly endMs: number;
  /** When the event was emitted, ms on the call clock. */
  readonly emittedAtMs: number;
}

export interface SttSessionOptions {
  readonly locale: LocaleId;
  readonly callId: string;
  /**
   * Text context for the recogniser (e.g. the agent's last question), where
   * the provider supports it; ElevenLabs takes it once, with the first audio.
   */
  readonly previousText?: string;
}

export interface SttSession {
  pushAudio(frame: AudioFrame): void;
  onTranscript(handler: (event: TranscriptEvent) => void): Unsubscribe;
  close(): Promise<void>;
}

/** One session per call and locale. */
export interface StreamingSpeechToText {
  readonly provider: string;
  open(options: SttSessionOptions): Promise<SttSession>;
}

export interface TtsAudioChunk {
  readonly data: Uint8Array;
  /** Sentence this chunk belongs to (0-based within the session). */
  readonly sentenceIndex: number;
  readonly firstOfSentence: boolean;
  readonly lastOfSentence: boolean;
  /** Duration of the audio in the chunk, ms. */
  readonly durationMs: number;
  /** Emission time on the call clock, ms. */
  readonly emittedAtMs: number;
}

export interface TtsSessionOptions {
  readonly locale: LocaleId;
  readonly callId: string;
  readonly voiceId?: string;
}

export interface TtsSession {
  /** Synthesizes one sentence; the iterable ends early after cancel(). */
  speak(sentence: string): AsyncIterable<TtsAudioChunk>;
  /** Barge-in: stop the current sentence and drop any queued audio. */
  cancel(): void;
  close(): Promise<void>;
}

export interface StreamingTextToSpeech {
  readonly provider: string;
  open(options: TtsSessionOptions): Promise<TtsSession>;
}

export type CallDirection = 'INBOUND' | 'OUTBOUND';

export type CallEvent =
  | {
      readonly type: 'incoming';
      readonly callId: string;
      readonly from: string;
      readonly to: string;
    }
  | { readonly type: 'answered'; readonly callId: string }
  | {
      readonly type: 'transferred';
      readonly callId: string;
      readonly toNumber: string;
    }
  | {
      readonly type: 'ended';
      readonly callId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'failed';
      readonly callId: string;
      readonly error: string;
    };

export interface AudioSendReceipt {
  /** When the audio starts playing at the far end, ms on the call clock. */
  readonly playbackStartMs: number;
}

/** The media side of one answered call. */
export interface CallLeg {
  readonly callId: string;
  readonly direction: CallDirection;
  readonly remoteNumber: string;
  /** Caller audio frames. */
  onAudio(handler: (frame: AudioFrame) => void): Unsubscribe;
  sendAudio(chunk: TtsAudioChunk): AudioSendReceipt;
  /** Drop audio queued for playout (barge-in). */
  clearPlayback(): void;
  /**
   * True while sent audio is still queued or playing at the far end. Real
   * legs implement it so barge-in also works after generation has finished.
   */
  isPlayingOut?(): boolean;
}

export type TelephonyFailure =
  'ACCEPT_FAILED' | 'PLACE_FAILED' | 'TRANSFER_FAILED' | 'HANGUP_FAILED';

export class TelephonyError extends Error {
  constructor(
    readonly failure: TelephonyFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TelephonyError';
  }
}

export interface TelephonyGateway {
  onCallEvent(handler: (event: CallEvent) => void): Unsubscribe;
  acceptInbound(callId: string): Promise<CallLeg>;
  placeOutbound(options: {
    readonly to: string;
    readonly from?: string;
  }): Promise<CallLeg>;
  transfer(callId: string, toNumber: string): Promise<void>;
  hangUp(callId: string, reason: string): Promise<void>;
}

export interface RecordingPutInput {
  readonly tenantId: string;
  readonly callId: string;
  readonly data: Uint8Array;
  readonly contentType: string;
  readonly startedAt: Date;
  /** Id of the KMS key (or equivalent) the adapter encrypts with; never key material. */
  readonly encryptionKeyRef?: string;
}

export interface RecordingPutResult {
  readonly recordingId: string;
  readonly retainUntil: Date;
}

export interface PlaybackRequest {
  readonly tenantId: string;
  readonly recordingId: string;
  readonly requester: { readonly userId: string; readonly role: string };
  readonly ttlSeconds: number;
}

export type PlaybackResult =
  | { readonly ok: true; readonly url: string; readonly expiresAt: Date }
  | { readonly ok: false; readonly reason: 'FORBIDDEN' | 'NOT_FOUND' };

export interface CallRecordingStore {
  put(input: RecordingPutInput): Promise<RecordingPutResult>;
  /** Signed, short-lived playback URL; restricted by role (policies.ts). */
  createPlaybackUrl(request: PlaybackRequest): Promise<PlaybackResult>;
}

/** One utterance event the responder emits while a turn is generated. */
export type ResponderEvent =
  /** Streamed text; the orchestrator cuts it into sentences. */
  | { readonly type: 'text'; readonly text: string }
  /** One sentence already checked and rendered; spoken as it is. */
  | { readonly type: 'sentence'; readonly text: string }
  /** "One moment" while the reply waits on a tool or a slow model. */
  | { readonly type: 'filler'; readonly text: string }
  | { readonly type: 'handover'; readonly reason: string };

export interface TurnInput {
  readonly callId: string;
  readonly locale: LocaleId;
  readonly transcript: string;
  readonly turnIndex: number;
}

/** Produces the reply of one turn as a stream. The LLM plugs in here later. */
export interface TurnResponder {
  respond(input: TurnInput, signal: AbortSignal): AsyncIterable<ResponderEvent>;
}
