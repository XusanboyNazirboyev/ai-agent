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
import { retryWithBackoff } from '../resilience/retry.js';

/**
 * amoCRM REST client (ADR 081; docs/connectors/amocrm/README.md).
 *
 * - The host is built here from a validated subdomain: `<subdomain>.amocrm.ru`
 *   over https. No other host, no redirects.
 * - Only the four calls in AMOCRM_ENDPOINTS exist; anything else throws before
 *   any I/O.
 * - The long-lived token goes only into the Authorization header. It is never
 *   put in an error, a log line or a returned value: every failure is rebuilt
 *   here with a fixed message and no cause from below.
 * - At most 5 requests a second per subdomain (the docs allow 7 per
 *   integration), serial per client. 429 is retried with backoff; 403 (the
 *   account is blocked after repeated violations) stops all calls to that
 *   subdomain for a while.
 *
 * Limits: https://www.amocrm.ru/developers/content/api/recommendations
 * (read 2026-11-19).
 */
export const AMOCRM_ENDPOINTS = [
  'GET /api/v4/account',
  'GET /api/v4/leads/pipelines',
  'GET /api/v4/leads',
  'POST /api/v4/leads/complex',
] as const;

export type AmocrmEndpoint = (typeof AMOCRM_ENDPOINTS)[number];

const SOURCE = 'amocrm';
export const SUBDOMAIN_PATTERN = /^[a-z0-9-]{1,63}$/u;
const QUERY_KEY = /^[A-Za-z0-9_[\]]{1,64}$/u;
/** After a 403 no call is sent to the subdomain for this long. */
export const BLOCKED_COOLDOWN_MS = 10 * 60_000;

export interface AmocrmRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

/** The transport the client needs: one request. Tests replace it. */
export type AmocrmTransport = (
  request: AmocrmRequest,
) => Promise<{ status: number; body: unknown }>;

/** Request pacing shared by every client of one subdomain in this process. */
export class RateGate {
  private last = Number.NEGATIVE_INFINITY;
  blockedUntil = 0;
  constructor(readonly minIntervalMs: number) {}
  async pace(
    now: () => number,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    const wait = this.last + this.minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    this.last = now();
  }
}

const sharedGates = new Map<string, RateGate>();
function sharedGate(subdomain: string): RateGate {
  let gate = sharedGates.get(subdomain);
  if (!gate) {
    gate = new RateGate(200);
    sharedGates.set(subdomain, gate);
  }
  return gate;
}

export interface AmocrmClientOptions {
  readonly subdomain: string;
  readonly token: string;
  readonly transport?: AmocrmTransport;
  /** Tests: a private gate with this gap instead of the shared 200 ms one. */
  readonly minIntervalMs?: number;
  /** Retries after HTTP 429 (default 3: 1 s, 2 s, 4 s). */
  readonly maxRateRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export function parseSubdomain(raw: string): string {
  if (!SUBDOMAIN_PATTERN.test(raw)) {
    throw new ConnectorConfigurationError({
      message: 'amoCRM subdomain must be 1-63 characters: a-z, 0-9, -',
      code: 'AMOCRM_INVALID_SUBDOMAIN',
      source: SOURCE,
    });
  }
  return raw;
}

export function amocrmOrigin(subdomain: string): string {
  return `https://${parseSubdomain(subdomain)}.amocrm.ru`;
}

/**
 * Default transport: the hardened connector HTTP client (SSRF checks, pinned
 * DNS) with redirects off, errors re-wrapped without message or cause.
 */
export function restTransport(
  options: Omit<RestHttpClientOptions, 'maxRedirects'> = {},
  http: Pick<RestHttpClient, 'send'> = new RestHttpClient({
    ...options,
    maxRedirects: 0,
  }),
): AmocrmTransport {
  return async (request) => {
    try {
      const response = await http.send({
        method: request.method,
        url: request.url,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        timeoutMs: 15_000,
      });
      return { status: response.status, body: response.body };
    } catch (error: unknown) {
      throw scrubbed(error);
    }
  };
}

function scrubbed(error: unknown): ConnectorError {
  if (
    isConnectorError(error) &&
    error.code === 'CONNECTOR_TOO_MANY_REDIRECTS'
  ) {
    return new ConnectorConfigurationError({
      message: 'amoCRM answered with a redirect; redirects are not followed',
      code: 'AMOCRM_REDIRECT_REFUSED',
      source: SOURCE,
      executed: 'no',
    });
  }
  if (!isConnectorError(error)) {
    return new ConnectorUnavailableError({
      message: 'amoCRM request failed',
      code: 'AMOCRM_TRANSPORT_ERROR',
      source: SOURCE,
      executed: 'unknown',
    });
  }
  return new ConnectorError({
    message: `amoCRM request failed (${error.code})`,
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    source: SOURCE,
    retryAfterMs: error.retryAfterMs,
    executed: error.executed,
  });
}

function notAllowed(label: string): ConnectorError {
  return new ConnectorError({
    message: `amoCRM call not allowed: ${/^[A-Z]{3,6} \/[a-z0-9/_.-]{1,64}$/u.test(label) ? label : '(invalid)'}`,
    code: 'AMOCRM_METHOD_NOT_ALLOWED',
    category: ConnectorErrorCategory.CAPABILITY,
    source: SOURCE,
    executed: 'no',
  });
}

export type AmocrmQuery = Readonly<Record<string, string | number>>;

export class AmocrmClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly transport: AmocrmTransport;
  private readonly gate: RateGate;
  private readonly maxRateRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AmocrmClientOptions) {
    this.origin = amocrmOrigin(options.subdomain);
    if (!options.token || /[\r\n]/u.test(options.token)) {
      throw new ConnectorConfigurationError({
        message: 'amoCRM token is empty or malformed',
        code: 'AMOCRM_INVALID_TOKEN',
        source: SOURCE,
      });
    }
    this.token = options.token;
    this.transport = options.transport ?? restTransport();
    this.gate =
      options.minIntervalMs !== undefined
        ? new RateGate(options.minIntervalMs)
        : sharedGate(options.subdomain);
    this.maxRateRetries = options.maxRateRetries ?? 3;
    this.sleep =
      options.sleep ??
      ((ms): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  get(path: string, query: AmocrmQuery = {}): Promise<unknown> {
    return this.call('GET', path, query, undefined);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.call('POST', path, {}, body);
  }

  /** Serial: one request at a time per client. */
  private call(
    method: 'GET' | 'POST',
    path: string,
    query: AmocrmQuery,
    body: unknown,
  ): Promise<unknown> {
    const label = `${method} ${path}`;
    if (!(AMOCRM_ENDPOINTS as readonly string[]).includes(label))
      throw notAllowed(label);
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (!QUERY_KEY.test(key)) throw notAllowed(label);
      search.set(key, String(value));
    }
    const qs = search.toString();
    const request: AmocrmRequest = {
      method,
      url: `${this.origin}${path}${qs ? `?${qs}` : ''}`,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body } : {}),
    };
    const run = this.queue.then(() => this.send(label, request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(label: string, request: AmocrmRequest): Promise<unknown> {
    return retryWithBackoff(
      async () => {
        if (this.gate.blockedUntil > this.now()) throw blocked(label);
        await this.gate.pace(this.now, this.sleep);
        const response = await this.transport(request);
        return this.interpret(label, response);
      },
      {
        attempts: this.maxRateRetries + 1,
        baseMs: 1_000,
        maxMs: 8_000,
        sleep: this.sleep,
        isRetryable: (error) =>
          isConnectorError(error) && error.code === 'AMOCRM_RATE_LIMITED',
      },
    );
  }

  private interpret(
    label: string,
    response: { status: number; body: unknown },
  ): unknown {
    const { status } = response;
    if (status >= 200 && status < 300) {
      // 204: an empty list has no body.
      return status === 204 ? null : response.body;
    }
    if (status === 429)
      throw new ConnectorError({
        message: `amoCRM ${label}: request limit exceeded`,
        code: 'AMOCRM_RATE_LIMITED',
        category: ConnectorErrorCategory.RATE_LIMITED,
        retryable: true,
        retryAfterMs: 2_000,
        source: SOURCE,
        executed: 'no',
      });
    if (status === 403) {
      // Repeated violations block the account with 403 on every request.
      this.gate.blockedUntil = this.now() + BLOCKED_COOLDOWN_MS;
      throw blocked(label);
    }
    const message = `amoCRM ${label} failed: HTTP_${status}`;
    if (status === 401)
      throw new ConnectorUnauthorizedError({
        message,
        code: 'AMOCRM_UNAUTHORIZED',
        source: SOURCE,
        executed: 'no',
      });
    if (status === 402)
      throw new ConnectorError({
        message,
        code: 'AMOCRM_PAYMENT_REQUIRED',
        category: ConnectorErrorCategory.AUTHORIZATION,
        source: SOURCE,
        executed: 'no',
      });
    if (status === 400 || status === 404 || status === 422)
      throw new ConnectorError({
        message,
        code: `AMOCRM_HTTP_${status}`,
        category: ConnectorErrorCategory.VALIDATION,
        source: SOURCE,
        executed: 'no',
      });
    // 5xx and anything else: the outcome of a write is not known.
    throw new ConnectorUnavailableError({
      message,
      code: `AMOCRM_HTTP_${status}`,
      source: SOURCE,
      retryable: status >= 500,
      executed: 'unknown',
    });
  }
}

function blocked(label: string): ConnectorError {
  return new ConnectorError({
    message: `amoCRM ${label}: access blocked (HTTP 403)`,
    code: 'AMOCRM_FORBIDDEN',
    category: ConnectorErrorCategory.AUTHORIZATION,
    source: SOURCE,
    executed: 'no',
  });
}
