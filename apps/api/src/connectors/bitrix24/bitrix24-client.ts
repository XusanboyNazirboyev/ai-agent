import {
  RestHttpClient,
  type RestHttpClientOptions,
} from '../generic-rest/http-client.js';
import {
  ConnectorConfigurationError,
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorUnauthorizedError,
  ConnectorUnavailableError,
  isConnectorError,
} from '../interfaces/errors.js';

/**
 * Bitrix24 inbound-webhook REST client (docs/connectors/bitrix24/CONNECTOR_PLAN.md).
 *
 * - Only the methods in BITRIX24_METHODS can be called; anything else, or an
 *   allowed method with a forbidden entity, throws before any I/O.
 * - The webhook URL is a credential (its path holds the secret code). It is
 *   never put in an error, log line or returned value: every failure is
 *   rebuilt here with a fixed message, without the transport's cause.
 * - Requests are POST + JSON over https (RestHttpClient: SSRF checks, pinned
 *   DNS), serial and paced per portal; 503 QUERY_LIMIT_EXCEEDED is retried
 *   with backoff, 429 OPERATION_TIME_LIMIT is surfaced with a retry delay.
 *
 * Limits (https://apidocs.bitrix24.com/limits.html, read 2026-10-27): leaky
 * bucket draining 2/s with threshold 50 on non-enterprise plans, shared per
 * portal and source IP; the default pace here is half of that.
 */
export const BITRIX24_METHODS = [
  'crm.settings.mode.get',
  'crm.duplicate.findbycomm',
  'crm.item.add',
  'crm.item.list',
  'crm.item.fields',
  'crm.timeline.comment.add',
] as const;

export type Bitrix24Method = (typeof BITRIX24_METHODS)[number];

/** Lead is the only CRM entity this connector may touch (entityTypeId 1). */
export const LEAD_ENTITY_TYPE_ID = 1;

const SOURCE = 'bitrix24';
const WEBHOOK_PATH = /^\/rest\/\d{1,10}\/[A-Za-z0-9]{8,64}\/$/u;

export interface Bitrix24Response {
  readonly result: unknown;
  readonly time?: { readonly operating_reset_at?: number };
}

/** The transport the client needs: one JSON POST. Tests replace it. */
export type Bitrix24Transport = (
  url: string,
  body: unknown,
) => Promise<{ status: number; body: unknown }>;

export interface Bitrix24ClientOptions {
  readonly webhookUrl: string;
  readonly transport?: Bitrix24Transport;
  /** Minimum gap between requests (default 1000 ms, i.e. 1 per second). */
  readonly minIntervalMs?: number;
  /** Retries after 503 QUERY_LIMIT_EXCEEDED (default 3: 1 s, 2 s, 4 s). */
  readonly maxRateRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}

/**
 * Validates an inbound webhook URL: https, no credentials, query or fragment,
 * path exactly /rest/<user id>/<code>/. The message never echoes the URL.
 */
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidWebhook('is not a URL');
  }
  if (url.protocol !== 'https:') throw invalidWebhook('must use https');
  if (url.username || url.password)
    throw invalidWebhook('must not contain credentials');
  if (url.search || url.hash)
    throw invalidWebhook('must not have a query or fragment');
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  if (!WEBHOOK_PATH.test(path))
    throw invalidWebhook('must have the path /rest/<user id>/<code>/');
  return new URL(`${url.origin}${path}`);
}

function invalidWebhook(reason: string): ConnectorConfigurationError {
  return new ConnectorConfigurationError({
    message: `Bitrix24 webhook URL ${reason}`,
    code: 'BITRIX24_INVALID_WEBHOOK_URL',
    source: SOURCE,
  });
}

/** Refuses a call before any I/O unless the method and its entity are allowed. */
export function assertAllowed(method: string, params: unknown): void {
  if (!(BITRIX24_METHODS as readonly string[]).includes(method)) {
    throw notAllowed(method);
  }
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method as Bitrix24Method) {
    case 'crm.item.add':
    case 'crm.item.list':
    case 'crm.item.fields':
      if (p.entityTypeId !== LEAD_ENTITY_TYPE_ID) throw notAllowed(method);
      break;
    case 'crm.timeline.comment.add': {
      const fields = (p.fields ?? {}) as Record<string, unknown>;
      if (fields.ENTITY_TYPE !== 'lead') throw notAllowed(method);
      break;
    }
    case 'crm.duplicate.findbycomm':
      if (p.type !== 'PHONE') throw notAllowed(method);
      break;
    case 'crm.settings.mode.get':
      break;
  }
}

function notAllowed(method: string): ConnectorError {
  return new ConnectorError({
    message: `Bitrix24 method not allowed: ${/^[a-z.]{1,64}$/u.test(method) ? method : '(invalid name)'}`,
    code: 'BITRIX24_METHOD_NOT_ALLOWED',
    category: ConnectorErrorCategory.CAPABILITY,
    source: SOURCE,
    executed: 'no',
  });
}

/**
 * Default transport: the hardened connector HTTP client, errors re-wrapped.
 * Redirects are never followed (maxRedirects 0): a same-origin 307/308
 * would replay the POST body to another path, i.e. another method, past the
 * allow-list. A redirect is refused as BITRIX24_REDIRECT_REFUSED.
 * `options` is for tests (DNS, loopback exemptions); maxRedirects is fixed.
 */
export function restTransport(
  options: Omit<RestHttpClientOptions, 'maxRedirects'> = {},
  http: Pick<RestHttpClient, 'send'> = new RestHttpClient({
    ...options,
    maxRedirects: 0,
  }),
): Bitrix24Transport {
  return async (url, body) => {
    try {
      const response = await http.send({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        timeoutMs: 15_000,
      });
      return { status: response.status, body: response.body };
    } catch (error: unknown) {
      throw scrubbed(error);
    }
  };
}

/** Same category, code and write semantics; no message or cause from below. */
function scrubbed(error: unknown): ConnectorError {
  if (
    isConnectorError(error) &&
    error.code === 'CONNECTOR_TOO_MANY_REDIRECTS'
  ) {
    // The portal answered with a redirect instead of handling the call.
    return new ConnectorConfigurationError({
      message: 'Bitrix24 answered with a redirect; redirects are not followed',
      code: 'BITRIX24_REDIRECT_REFUSED',
      source: SOURCE,
      executed: 'no',
    });
  }
  if (!isConnectorError(error)) {
    return new ConnectorUnavailableError({
      message: 'Bitrix24 request failed',
      code: 'BITRIX24_TRANSPORT_ERROR',
      source: SOURCE,
      executed: 'unknown',
    });
  }
  return new ConnectorError({
    message: `Bitrix24 request failed (${error.code})`,
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    source: SOURCE,
    retryAfterMs: error.retryAfterMs,
    executed: error.executed,
  });
}

export class Bitrix24Client {
  private readonly base: URL;
  private readonly transport: Bitrix24Transport;
  private readonly minIntervalMs: number;
  private readonly maxRateRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();
  /** Per method: no call before this time (429 OPERATION_TIME_LIMIT). */
  private readonly suspendedUntil = new Map<string, number>();
  private operatingResetAt: number | undefined;

  constructor(options: Bitrix24ClientOptions) {
    this.base = parseWebhookUrl(options.webhookUrl);
    this.transport = options.transport ?? restTransport();
    this.minIntervalMs = options.minIntervalMs ?? 1_000;
    this.maxRateRetries = options.maxRateRetries ?? 3;
    this.sleep =
      options.sleep ??
      ((ms): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Serial: one request at a time per client (no parallel series). */
  call(
    method: Bitrix24Method,
    params: unknown = {},
  ): Promise<Bitrix24Response> {
    assertAllowed(method, params);
    const run = this.queue.then(() => this.send(method, params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(
    method: Bitrix24Method,
    params: unknown,
  ): Promise<Bitrix24Response> {
    const suspended = this.suspendedUntil.get(method);
    if (suspended !== undefined && suspended > this.now()) {
      throw timeLimited(method, suspended - this.now());
    }
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      const response = await this.transport(
        new URL(`${method}.json`, this.base).toString(),
        params,
      );
      const body = (response.body ?? {}) as Record<string, unknown>;
      const code = typeof body.error === 'string' ? body.error : undefined;
      if (response.status === 503 && code === 'QUERY_LIMIT_EXCEEDED') {
        // The docs say the request is blocked, so it was not applied.
        if (attempt < this.maxRateRetries) {
          await this.sleep(1_000 * 2 ** attempt * (0.75 + this.random() * 0.5));
          continue;
        }
        throw new ConnectorError({
          message: `Bitrix24 ${method}: request limit exceeded`,
          code: 'BITRIX24_QUERY_LIMIT_EXCEEDED',
          category: ConnectorErrorCategory.RATE_LIMITED,
          retryable: true,
          retryAfterMs: 2_000,
          source: SOURCE,
          executed: 'no',
        });
      }
      if (response.status === 429 || code === 'OPERATION_TIME_LIMIT') {
        const resetMs =
          this.operatingResetAt !== undefined
            ? Math.max(1_000, this.operatingResetAt * 1_000 - this.now())
            : 60_000;
        this.suspendedUntil.set(method, this.now() + resetMs);
        throw timeLimited(method, resetMs);
      }
      if (response.status >= 200 && response.status < 300 && !code) {
        const time = body.time as Bitrix24Response['time'];
        if (typeof time?.operating_reset_at === 'number')
          this.operatingResetAt = time.operating_reset_at;
        return { result: body.result, time };
      }
      throw apiError(method, response.status, code);
    }
  }
}

function timeLimited(method: string, retryAfterMs: number): ConnectorError {
  return new ConnectorError({
    message: `Bitrix24 ${method}: operation time limit reached`,
    code: 'BITRIX24_OPERATION_TIME_LIMIT',
    category: ConnectorErrorCategory.RATE_LIMITED,
    retryable: true,
    retryAfterMs,
    source: SOURCE,
    executed: 'no',
  });
}

const AUTH_CODES = new Set([
  'NO_AUTH_FOUND',
  'INVALID_CREDENTIALS',
  'insufficient_scope',
  'expired_token',
]);
const ACCESS_CODES = new Set([
  'ACCESS_DENIED',
  'allowed_only_intranet_user',
  'user_access_error',
]);
const CONFIG_CODES = new Set(['ERROR_METHOD_NOT_FOUND', 'PORTAL_DELETED']);
/** The request was refused before it could change anything. */
const VALIDATION_CODES = new Set([
  'INVALID_ARG_VALUE',
  'INVALID_REQUEST',
  'CRM_FIELD_ERROR_VALUE_NOT_VALID',
  'NOT_FOUND',
  'OWNER_NOT_FOUND',
  '100',
]);

/** Maps a Bitrix24 error to a connector error: code only, never the body. */
function apiError(
  method: string,
  status: number,
  code: string | undefined,
): ConnectorError {
  const label =
    code && /^[A-Za-z0-9_]{1,64}$/u.test(code) ? code : `HTTP_${status}`;
  const message = `Bitrix24 ${method} failed: ${label}`;
  if (code && AUTH_CODES.has(code))
    return new ConnectorUnauthorizedError({
      message,
      code: `BITRIX24_${label.toUpperCase()}`,
      source: SOURCE,
      executed: 'no',
    });
  if (code && ACCESS_CODES.has(code))
    return new ConnectorError({
      message,
      code: `BITRIX24_${label.toUpperCase()}`,
      category: ConnectorErrorCategory.AUTHORIZATION,
      source: SOURCE,
      executed: 'no',
    });
  if (code && CONFIG_CODES.has(code))
    return new ConnectorConfigurationError({
      message,
      code: `BITRIX24_${label.toUpperCase()}`,
      source: SOURCE,
      executed: 'no',
    });
  if (code && VALIDATION_CODES.has(code))
    return new ConnectorError({
      message,
      code: `BITRIX24_${label.toUpperCase()}`,
      category: ConnectorErrorCategory.VALIDATION,
      source: SOURCE,
      executed: 'no',
    });
  // 5xx, unknown codes: the outcome of a write is not known.
  return new ConnectorUnavailableError({
    message,
    code: `BITRIX24_${label.toUpperCase()}`,
    source: SOURCE,
    retryable: status >= 500,
    executed: 'unknown',
  });
}
