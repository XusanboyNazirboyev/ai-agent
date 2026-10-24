import type { WriteIdempotency } from '../interfaces/crm-connector.js';

/**
 * Pure decisions for one logical external write (ADR 023). Nothing here does
 * I/O; the store and the callers apply the decisions.
 */
export type WriteExecution = 'NOT_EXECUTED' | 'UNCERTAIN';

export interface PreviousAttempt {
  /** What the previous failed attempt proved, if any attempt failed. */
  readonly lastExecution: WriteExecution | null;
  /** The previous attempt never reported back (worker crash, lost result). */
  readonly abandoned: boolean;
  /** Idempotency mode in force during that attempt. */
  readonly attemptMode: WriteIdempotency | null;
}

/**
 * What to do before the next attempt.
 *  - ATTEMPT: call the connector (with the same key as always);
 *  - LOOKUP_THEN_ATTEMPT: ask the connector whether the earlier attempt
 *    created the record; create only if it did not;
 *  - STOP_UNCERTAIN: the earlier attempt may have been applied and nothing
 *    can tell: do not call again, wait for a person.
 * Recovery is safe only when the earlier attempt AND the next one run under
 * the same protecting mode: a key sent to a system that did not honour it at
 * the time cannot deduplicate it afterwards.
 */
export function beforeAttempt(
  previous: PreviousAttempt,
  currentMode: WriteIdempotency,
): 'ATTEMPT' | 'LOOKUP_THEN_ATTEMPT' | 'STOP_UNCERTAIN' {
  const unclear = previous.abandoned || previous.lastExecution === 'UNCERTAIN';
  if (!unclear) return 'ATTEMPT';
  if (previous.attemptMode === 'native' && currentMode === 'native')
    return 'ATTEMPT';
  if (previous.attemptMode === 'lookup' && currentMode === 'lookup')
    return 'LOOKUP_THEN_ATTEMPT';
  return 'STOP_UNCERTAIN';
}

export type AfterFailure =
  | { readonly status: 'RETRY_WAIT'; readonly delayMs: number }
  | { readonly status: 'FAILED' }
  | { readonly status: 'UNCERTAIN' };

/** What a failed attempt leads to. `attempts` counts the one that just failed. */
export function afterFailure(
  execution: WriteExecution,
  mode: WriteIdempotency,
  attempts: number,
  maxAttempts: number,
  delayFor: (attempts: number) => number,
): AfterFailure {
  const exhausted = attempts >= maxAttempts;
  if (execution === 'NOT_EXECUTED')
    return exhausted
      ? { status: 'FAILED' }
      : { status: 'RETRY_WAIT', delayMs: delayFor(attempts) };
  // The write may have been applied: retry only where it is provably safe.
  if (mode === 'none' || exhausted) return { status: 'UNCERTAIN' };
  return { status: 'RETRY_WAIT', delayMs: delayFor(attempts) };
}
