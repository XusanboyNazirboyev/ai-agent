import { ConnectorTimeoutError } from '../interfaces/errors.js';

/**
 * Bounded request timeout.
 *
 * Every external CRM request must complete within a configured deadline. The
 * returned promise rejects with a ConnectorTimeoutError on expiry. The caller is
 * responsible for aborting the underlying request (e.g. AbortController) so no
 * work hangs indefinitely.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  options: { ms: number; source?: string; operation?: string },
): Promise<T> {
  const { ms, source, operation } = options;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`withTimeout requires a positive ms, got ${ms}`);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new ConnectorTimeoutError({
          message: `${operation ?? 'connector'} request timed out after ${ms}ms`,
          code: 'CONNECTOR_TIMEOUT',
          source,
        }),
      );
    }, ms);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
