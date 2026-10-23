import {
  ConnectorError,
  ConnectorErrorCategory,
  isConnectorError,
  isRetryableConnectorError,
} from '../interfaces/errors.js';

/**
 * Exponential backoff with optional jitter for bounded retry loops.
 *
 * Returns the delay in milliseconds for the given attempt index (0-based).
 * Jitter is applied only when enabled, using a deterministic fraction so tests
 * can assert bounds without randomness.
 */
export function backoffDelayMs(
  attemptIndex: number,
  options: {
    baseMs: number;
    maxMs: number;
    jitter?: boolean;
  },
): number {
  const { baseMs, maxMs, jitter = false } = options;
  if (baseMs <= 0 || maxMs <= 0 || maxMs < baseMs) {
    throw new Error('backoffDelayMs requires positive baseMs <= maxMs');
  }
  const exponential = baseMs * 2 ** attemptIndex;
  let delay = Math.min(exponential, maxMs);
  if (jitter) {
    // Deterministic jitter in [0, 25%] of the delay.
    delay = Math.floor(delay * (0.75 + (attemptIndex % 4) * 0.0625));
  }
  return Math.max(1, Math.min(delay, maxMs));
}

export interface RetryOptions {
  readonly attempts: number; // total attempts including the first try
  readonly baseMs: number;
  readonly maxMs: number;
  readonly jitter?: boolean;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly onRetry?: (attempt: number, error: unknown) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class RetryExhaustedError extends ConnectorError {
  constructor(options: {
    source?: string;
    lastError: unknown;
    attempts: number;
  }) {
    super({
      message: `connector operation failed after ${options.attempts} attempts`,
      code: 'CONNECTOR_RETRIES_EXHAUSTED',
      category: ConnectorErrorCategory.UNAVAILABLE,
      retryable: false,
      source: options.source,
      cause: options.lastError,
    });
    this.name = 'RetryExhaustedError';
  }
}

/**
 * Execute `fn` with bounded retries. Only transient/retryable errors are
 * retried. Permanent errors (configuration, auth, validation, capability) are
 * thrown immediately, and so is the last error once attempts are exhausted.
 *
 * An upstream-requested delay (`ConnectorError.retryAfterMs`, from
 * `Retry-After`) is honoured as a minimum. When it exceeds `maxMs` the error
 * is thrown instead of retrying early against the provider's instruction.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    attempts,
    baseMs,
    maxMs,
    jitter = false,
    isRetryable = isRetryableConnectorError,
    onRetry,
    sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('retryWithBackoff requires attempts >= 1');
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error: unknown) {
      lastError = error;
      const retryable = isRetryable(error) && attempt < attempts - 1;
      if (!retryable) {
        throw error;
      }
      const requested = isConnectorError(error)
        ? error.retryAfterMs
        : undefined;
      if (requested !== undefined && requested > maxMs) {
        throw error;
      }
      const delay = Math.max(
        backoffDelayMs(attempt, { baseMs, maxMs, jitter }),
        requested ?? 0,
      );
      onRetry?.(attempt + 1, error);
      await sleep(delay);
    }
  }

  throw new RetryExhaustedError({
    source: undefined,
    lastError,
    attempts,
  });
}
