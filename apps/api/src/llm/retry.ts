/**
 * Retry timing for provider adapters: exponential backoff with "equal
 * jitter" (half fixed, half random) and support for Retry-After. Only
 * transient failures are retried; callers decide which those are.
 */

export const MAX_RETRY_DELAY_MS = 10_000;

/** Delay before retry `attempt` (1-based), in milliseconds. */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
  baseMs = 500,
  capMs = MAX_RETRY_DELAY_MS,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Parses Retry-After (delta seconds or an HTTP date). Returns undefined when
 * absent or unparseable; a value in the past becomes 0.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/u.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}
