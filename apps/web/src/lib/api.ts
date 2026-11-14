import en from '@/i18n/en.json';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** The API's own catalog key (`team.errors.LAST_OWNER`), when it sent one. */
    readonly i18nKey?: string,
  ) {
    super(code);
  }
}

/** The tenant session's CSRF cookie (ADR 020). */
export const TENANT_CSRF_COOKIE = 'ac_csrf';
/** The platform console's CSRF cookie (ADR 047 §1); never the tenant one. */
export const PLATFORM_CSRF_COOKIE = 'ac_platform_csrf';

export function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name)
      return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * A body sent as it is, with `contentType` (a CSV file, ADR 064); used
   * instead of `body`, which is always JSON.
   */
  rawBody?: string;
  contentType?: string;
  /** Adds a fresh Idempotency-Key (operator commands). */
  command?: boolean;
  /** Which session's CSRF cookie to echo on unsafe methods. */
  csrfCookie?: string;
}

/** All API calls: same-origin, cookie session, CSRF header on unsafe methods. */
export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.rawBody !== undefined)
    headers['content-type'] = options.contentType ?? 'text/plain';
  else if (options.body !== undefined)
    headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(options.csrfCookie ?? TENANT_CSRF_COOKIE);
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (options.command) headers['idempotency-key'] = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.rawBody !== undefined
        ? { body: options.rawBody }
        : options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const body =
      parsed && typeof parsed === 'object'
        ? (parsed as { code?: unknown; i18nKey?: unknown })
        : {};
    const code =
      body.code !== undefined
        ? String(body.code)
        : response.status === 401
          ? 'UNAUTHENTICATED'
          : 'UNKNOWN';
    throw new ApiError(
      response.status,
      code,
      typeof body.i18nKey === 'string' ? body.i18nKey : undefined,
    );
  }
  return parsed as T;
}

/** Platform console calls (ADR 047): the `ac_platform_csrf` cookie, never `ac_csrf`. */
export function platformApi<T>(
  path: string,
  options: Omit<Options, 'csrfCookie'> = {},
): Promise<T> {
  return api<T>(path, { ...options, csrfCookie: PLATFORM_CSRF_COOKIE });
}

/** Maps an error to the i18n key that explains it. */
export function errorKey(error: unknown): string {
  if (error instanceof ApiError) {
    // The API's specific key wins when the catalog has it (team and platform
    // rule errors); otherwise the generic message of the code.
    if (error.i18nKey && error.i18nKey in en) return error.i18nKey;
    return `errors.${error.code}`;
  }
  return 'errors.UNKNOWN';
}
