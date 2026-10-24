/**
 * Provider-neutral speech-to-text port (Phase 6, Open Question 8). No
 * provider is chosen or integrated yet: the first implementation waits for an
 * owner decision and for measured Uzbek quality. Everything a provider
 * adapter must obey (limits, failure semantics, accounting) is fixed here
 * and tested without any provider.
 */
export interface AudioClip {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly durationSeconds: number;
}

export type TranscriptionFailure =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED_LANGUAGE'
  | 'UNINTELLIGIBLE'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT';

export type TranscriptionResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** Language the provider reports, if any (unverified until measured). */
      readonly language?: string;
      /** Provider confidence if it reports one; not assumed calibrated. */
      readonly confidence?: number;
      /** Seconds of audio the provider bills, when it says so. */
      readonly billedSeconds?: number;
    }
  | { readonly ok: false; readonly code: TranscriptionFailure };

export interface SpeechToText {
  readonly providerId: string;
  readonly model: string;
  transcribe(
    clip: AudioClip,
    options?: { languageHint?: string; signal?: AbortSignal },
  ): Promise<TranscriptionResult>;
}

/** Default adapter while no provider is decided: always a typed failure. */
export class NotConfiguredSpeechToText implements SpeechToText {
  readonly providerId = 'none';
  readonly model = 'none';
  transcribe(): Promise<TranscriptionResult> {
    return Promise.resolve({ ok: false, code: 'NOT_CONFIGURED' });
  }
}

export interface VoicePolicy {
  readonly maxBytes: number;
  readonly maxSeconds: number;
  readonly allowedMimeTypes: readonly string[];
  /** A transcript shorter than this is not a message. */
  readonly minTranscriptChars: number;
  /** Below this reported confidence the text is used only after confirmation. */
  readonly confirmBelowConfidence: number;
  readonly timeoutMs: number;
  /** Failed voice attempts in a row before a person is asked. */
  readonly maxFailedAttempts: number;
}

export const DEFAULT_VOICE_POLICY: VoicePolicy = {
  maxBytes: 5 * 1024 * 1024,
  maxSeconds: 60,
  allowedMimeTypes: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav'],
  minTranscriptChars: 2,
  confirmBelowConfidence: 0.6,
  timeoutMs: 20_000,
  maxFailedAttempts: 2,
};

export type ClipRejection = 'TOO_LARGE' | 'TOO_LONG' | 'UNSUPPORTED_TYPE';

/** Checked BEFORE any audio is sent anywhere. */
export function checkClip(
  clip: Pick<AudioClip, 'mimeType' | 'durationSeconds'> & { size: number },
  policy: VoicePolicy = DEFAULT_VOICE_POLICY,
): { ok: true } | { ok: false; code: ClipRejection } {
  if (
    !policy.allowedMimeTypes.includes(
      clip.mimeType.split(';')[0].trim().toLowerCase(),
    )
  )
    return { ok: false, code: 'UNSUPPORTED_TYPE' };
  if (!(clip.size > 0) || clip.size > policy.maxBytes)
    return { ok: false, code: 'TOO_LARGE' };
  if (!(clip.durationSeconds > 0) || clip.durationSeconds > policy.maxSeconds)
    return { ok: false, code: 'TOO_LONG' };
  return { ok: true };
}

export type VoiceDecision =
  /** Use the transcript as the customer's message. */
  | {
      readonly action: 'USE_TEXT';
      readonly text: string;
      /** The agent must confirm what it understood before acting on it. */
      readonly needsConfirmation: boolean;
    }
  /** Ask the customer to type; nothing is passed to the agent. */
  | { readonly action: 'ASK_TO_TYPE'; readonly reason: string }
  /** Repeated failures: recommend a person (typed outcome, not a notification). */
  | { readonly action: 'HANDOVER'; readonly reason: string };

/**
 * A failed or empty transcription is NEVER a valid empty customer message:
 * it becomes a request to type, and after repeated failures a handover
 * recommendation. The transcript is untrusted customer text like any other.
 */
export function decideVoice(
  outcome: TranscriptionResult | { ok: false; code: ClipRejection },
  failedAttemptsBefore: number,
  policy: VoicePolicy = DEFAULT_VOICE_POLICY,
): VoiceDecision {
  if (outcome.ok) {
    const text = outcome.text.replace(/\s+/gu, ' ').trim();
    if (text.length >= policy.minTranscriptChars) {
      return {
        action: 'USE_TEXT',
        text,
        needsConfirmation:
          outcome.confidence === undefined ||
          outcome.confidence < policy.confirmBelowConfidence,
      };
    }
    return failed('UNINTELLIGIBLE', failedAttemptsBefore, policy);
  }
  return failed(outcome.code, failedAttemptsBefore, policy);
}

function failed(
  reason: string,
  before: number,
  policy: VoicePolicy,
): VoiceDecision {
  // An oversized or wrong-type clip can only be fixed by typing or a shorter
  // clip; count it like any other failure so the loop is bounded.
  return before + 1 >= policy.maxFailedAttempts
    ? { action: 'HANDOVER', reason }
    : { action: 'ASK_TO_TYPE', reason };
}

/** Upper bound of one transcription's cost from a per-minute price (nano-USD). */
export function worstCaseTranscriptionNano(
  nanoPerMinute: number,
  clip: Pick<AudioClip, 'durationSeconds'>,
  policy: VoicePolicy = DEFAULT_VOICE_POLICY,
): number {
  const seconds = Math.min(Math.ceil(clip.durationSeconds), policy.maxSeconds);
  // Providers often bill a minimum of one minute-fraction; round up whole seconds.
  return Math.ceil((nanoPerMinute * seconds) / 60);
}
