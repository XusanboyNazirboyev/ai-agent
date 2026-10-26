/**
 * STUCK trigger (spec §7.4): "question repeated twice without progress".
 * Deterministic and conservative: it needs `repeatLimit` earlier turns that
 * show the same lack of progress, and any progress (a new slot, a turn that
 * actually answered) resets it. Inputs are signals stored per turn, never raw
 * customer text.
 */
export interface PriorTurnSignal {
  readonly outcome: string;
  readonly askedSlot?: string | null;
  readonly slotsFilled?: number | null;
  readonly textFingerprint?: string | null;
}

export interface StuckPolicy {
  /** Earlier no-progress turns required before escalating. */
  readonly repeatLimit: number;
}

export const DEFAULT_STUCK_POLICY: StuckPolicy = { repeatLimit: 2 };

/** Minutes of silence after which an earlier turn no longer counts as part of the same dialogue. */
export const DEFAULT_STUCK_WINDOW_MINUTES = 30;

/**
 * "Without progress" only makes sense inside one dialogue. Of the earlier
 * turns (`newestFirst`, with their completion times) this keeps the newest
 * unbroken run that is still part of the dialogue happening now: every gap
 * (the newest turn to `now`, and between neighbouring turns) is at most
 * `windowMs`, and no turn is at or before `notBefore` (for example the end of
 * a human handover). Anything older belongs to an earlier visit and must not
 * make a fresh greeting look like a repeated question. Returned oldest first.
 */
export function selectEpisode<T extends { readonly completedAt: Date | null }>(
  newestFirst: readonly T[],
  now: Date,
  windowMs: number,
  notBefore?: Date,
): T[] {
  const episode: T[] = [];
  let later = now.getTime();
  for (const turn of newestFirst) {
    const at = turn.completedAt?.getTime();
    if (at === undefined) break;
    if (later - at > windowMs) break;
    if (notBefore && at <= notBefore.getTime()) break;
    episode.push(turn);
    later = at;
  }
  return episode.reverse();
}

export type StuckReason = 'SAME_QUESTION_REPEATED' | 'SAME_MESSAGE_REPEATED';

export interface CurrentTurnSignal {
  readonly outcome: string;
  readonly askedSlot?: string;
  readonly slotsFilled: number;
  readonly textFingerprint: string;
}

/** Outcomes in which the bot made no substantive progress. */
const NO_PROGRESS = new Set([
  'ASKED_SLOT',
  'FALLBACK',
  'NO_RESULTS',
  'CLARIFICATION_REQUIRED',
]);

/** Stable short fingerprint of normalized text (FNV-1a, 64-bit as two 32s). */
export function textFingerprint(normalized: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/**
 * `prior` is oldest-first. Turns that were handovers or answers break the
 * streak, so a conversation that is moving never trips the trigger.
 */
export function detectStuck(
  prior: readonly PriorTurnSignal[],
  current: CurrentTurnSignal,
  policy: StuckPolicy = DEFAULT_STUCK_POLICY,
): StuckReason | undefined {
  if (!NO_PROGRESS.has(current.outcome)) return undefined;
  const recent = prior.slice(-policy.repeatLimit);
  if (recent.length < policy.repeatLimit) return undefined;
  const noProgress = recent.every((turn) => NO_PROGRESS.has(turn.outcome));
  if (!noProgress) return undefined;
  // Slots grew somewhere in the window: the customer is giving information.
  const counts = [
    ...recent.map((t) => t.slotsFilled ?? 0),
    current.slotsFilled,
  ];
  if (counts[counts.length - 1] > counts[0]) return undefined;
  if (
    current.askedSlot !== undefined &&
    recent.every((turn) => turn.askedSlot === current.askedSlot)
  )
    return 'SAME_QUESTION_REPEATED';
  if (recent.every((turn) => turn.textFingerprint === current.textFingerprint))
    return 'SAME_MESSAGE_REPEATED';
  return undefined;
}
