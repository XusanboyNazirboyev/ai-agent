export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

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
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Adds a fresh Idempotency-Key (operator commands). */
  command?: boolean;
}

/** All API calls: same-origin, cookie session, CSRF header on unsafe methods. */
export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('ac_csrf');
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
      ...(options.body !== undefined
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
    const code =
      parsed && typeof parsed === 'object' && 'code' in parsed
        ? String((parsed as { code: unknown }).code)
        : response.status === 401
          ? 'UNAUTHENTICATED'
          : 'UNKNOWN';
    throw new ApiError(response.status, code);
  }
  return parsed as T;
}

/** Maps an error to the i18n key that explains it. */
export function errorKey(error: unknown): string {
  if (error instanceof ApiError) {
    return `errors.${error.code}`;
  }
  return 'errors.UNKNOWN';
}
