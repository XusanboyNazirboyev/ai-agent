import {
  ConnectorConfigurationError,
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorInvalidResponseError,
  ConnectorNotFoundError,
  ConnectorTimeoutError,
  ConnectorUnauthorizedError,
  ConnectorUnavailableError,
} from '../interfaces/errors.js';
import {
  createPinnedDispatcher,
  releaseDispatcher,
  resolvePinnedAddresses,
  type HostResolver,
  type PinnedDispatcherFactory,
} from './dns-pinning.js';
import {
  OutboundUrlPolicy,
  parseLoopbackExemptions,
  validateOutboundUrl,
  type ResolvedAddress,
} from './ssrf-protection.js';

export interface RestRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** Deadline for the whole operation: DNS, every redirect hop and the body. */
  readonly timeoutMs?: number;
  /** Caller cancellation (e.g. shutdown). */
  readonly signal?: AbortSignal;
}

export interface RestResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface RestHttpClientOptions {
  readonly defaultTimeoutMs?: number;
  readonly policy?: OutboundUrlPolicy;
  /** Redirect hops followed per request; each hop is fully re-validated. */
  readonly maxRedirects?: number;
  /** Responses larger than this are aborted while streaming. */
  readonly maxResponseBytes?: number;
  /** Deterministic DNS for tests. */
  readonly resolve?: HostResolver;
  /**
   * Exact loopback addresses that the STRICT policy lets a hostname resolve
   * to, over plain http, for local test servers. Code-only (tenant config can
   * never set it) and refused when NODE_ENV is production.
   */
  readonly exemptLoopbackAddresses?: readonly string[];
  /** Test-only trust anchors replacing the default CA store. */
  readonly trustedCertificates?: readonly string[];
  /** Observes dispatcher creation; defaults to the pinned undici Agent. */
  readonly createDispatcher?: PinnedDispatcherFactory;
  /** Receives cleanup failures, which never replace the request outcome. */
  readonly onCleanupError?: (error: unknown) => void;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_BODY_DUMP_LIMIT = 64 * 1024;
const MAX_REDIRECTS_LIMIT = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;
const TLS_ERROR_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$)/;

/** Origin plus path: safe for messages (no query string, no credentials). */
function describeTarget(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function errorCodeOf(error: unknown): string | undefined {
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth < 4;
    current = current.cause, depth++
  ) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** One deadline and one cancellation signal for an entire `send()` call. */
class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly detach: () => void;
  private timedOut = false;

  constructor(
    readonly ms: number,
    caller: AbortSignal | undefined,
  ) {
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort(new Error('connector request deadline exceeded'));
    }, ms);
    if (caller === undefined) {
      this.detach = (): void => undefined;
    } else if (caller.aborted) {
      this.controller.abort(caller.reason);
      this.detach = (): void => undefined;
    } else {
      const onAbort = (): void => this.controller.abort(caller.reason);
      caller.addEventListener('abort', onAbort, { once: true });
      this.detach = (): void => caller.removeEventListener('abort', onAbort);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get expired(): boolean {
    return this.timedOut;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted && !this.timedOut;
  }

  /** Rejects as soon as the deadline fires, even if `promise` cannot abort. */
  race<T>(promise: Promise<T>): Promise<T> {
    const { signal } = this.controller;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.detach();
  }
}

type HopResult =
  | {
      readonly kind: 'redirect';
      readonly status: number;
      readonly location: string;
    }
  | { readonly kind: 'response'; readonly response: RestResponse };

/**
 * Small, auditable HTTP client for connector outbound requests.
 *
 * Every hop (the first request and each redirect) resolves the hostname,
 * validates every answer, and connects through a dispatcher pinned to exactly
 * those addresses, so a DNS answer that changes between validation and
 * connection cannot steer the socket. Redirects are never followed by the
 * transport: each target is re-validated here, credentials and request bodies
 * never cross origins, and the previous body is discarded before its
 * dispatcher is released.
 *
 * Dispatcher ownership: `send()` creates one dispatcher per hop and releases
 * it in a `finally` after that hop's body has been consumed (graceful close)
 * or on any failure (destroy). Nothing holding a socket escapes `send()`;
 * the returned response is fully buffered.
 */
export class RestHttpClient {
  private readonly defaultTimeoutMs: number;
  private readonly policy: OutboundUrlPolicy;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly resolve: HostResolver | undefined;
  private readonly exemptAddresses: ReadonlySet<string>;
  private readonly trustedCertificates: readonly string[] | undefined;
  private readonly createDispatcher: PinnedDispatcherFactory;
  private readonly onCleanupError: ((error: unknown) => void) | undefined;

  constructor(options: RestHttpClientOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.policy = options.policy ?? OutboundUrlPolicy.STRICT;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.resolve = options.resolve;
    this.exemptAddresses = parseLoopbackExemptions(
      options.exemptLoopbackAddresses,
    );
    this.trustedCertificates = options.trustedCertificates;
    this.createDispatcher = options.createDispatcher ?? createPinnedDispatcher;
    this.onCleanupError = options.onCleanupError;

    if (
      !Number.isInteger(this.maxRedirects) ||
      this.maxRedirects < 0 ||
      this.maxRedirects > MAX_REDIRECTS_LIMIT
    ) {
      throw new ConnectorConfigurationError({
        message: `maxRedirects must be an integer between 0 and ${MAX_REDIRECTS_LIMIT}`,
      });
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new ConnectorConfigurationError({
        message: 'maxResponseBytes must be a positive integer',
      });
    }
    if (
      process.env.NODE_ENV === 'production' &&
      (this.exemptAddresses.size > 0 || this.trustedCertificates !== undefined)
    ) {
      throw new ConnectorConfigurationError({
        message:
          'Test-only SSRF exemptions and trust anchors are refused in production',
        code: 'CONNECTOR_TEST_ALLOWANCE_IN_PRODUCTION',
      });
    }
  }

  async send(request: RestRequest): Promise<RestResponse> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ConnectorConfigurationError({
        message: `Request timeout must be positive, got ${timeoutMs}`,
      });
    }

    const initial = this.parseUrl(request.url);
    const target = describeTarget(initial);
    const deadline = new Deadline(timeoutMs, request.signal);
    try {
      return await this.follow(request, initial, deadline);
    } catch (error: unknown) {
      throw this.toConnectorError(error, {
        deadline,
        method: request.method,
        target,
        timeoutMs,
      });
    } finally {
      deadline.dispose();
    }
  }

  private parseUrl(input: string): URL {
    // Shape check only (protocol, credentials, restricted names and IP
    // literals). DNS validation happens per hop, together with pinning.
    const validated = validateOutboundUrl(input, { policy: this.policy });
    return new URL(validated.href);
  }

  private async follow(
    request: RestRequest,
    initial: URL,
    deadline: Deadline,
  ): Promise<RestResponse> {
    let url = initial;
    let method = request.method;
    let body = method === 'GET' ? undefined : request.body;
    let headers: Record<string, string> = { accept: 'application/json' };
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      headers[name.toLowerCase()] = value;
    }

    for (let redirects = 0; ; redirects++) {
      const hop = await this.performHop(url, method, headers, body, deadline);
      if (hop.kind === 'response') return hop.response;

      if (redirects >= this.maxRedirects) {
        throw new ConnectorUnavailableError({
          message: `Too many redirects for ${request.method} ${describeTarget(initial)}`,
          code: 'CONNECTOR_TOO_MANY_REDIRECTS',
          retryable: false,
        });
      }

      let next: URL;
      try {
        next = this.parseUrl(new URL(hop.location, url).href);
      } catch (error: unknown) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorInvalidResponseError({
          message: `Invalid redirect target from ${describeTarget(url)}`,
          code: 'CONNECTOR_INVALID_REDIRECT',
        });
      }

      // 303, and legacy 301/302 on POST, continue as a bodyless GET.
      if (
        hop.status === 303 ||
        ((hop.status === 301 || hop.status === 302) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
      }

      if (next.origin !== url.origin) {
        if (body !== undefined) {
          // A 307/308 would replay the request body (lead or booking data)
          // to a different origin.
          throw new ConnectorUnavailableError({
            message: `Refusing to forward a request body across origins from ${describeTarget(url)}`,
            code: 'CONNECTOR_REDIRECT_BLOCKED',
            retryable: false,
          });
        }
        // Credentials and every other caller-supplied header stay with the
        // origin they were configured for.
        headers = { accept: headers.accept ?? 'application/json' };
      }
      url = next;
    }
  }

  private async performHop(
    url: URL,
    method: RestRequest['method'],
    headers: Record<string, string>,
    body: unknown,
    deadline: Deadline,
  ): Promise<HopResult> {
    // dns.lookup cannot be aborted, so the deadline races it.
    const addresses = await deadline.race(
      resolvePinnedAddresses(url.hostname, {
        policy: this.policy,
        resolve: this.resolve,
        exemptAddresses: this.exemptAddresses,
      }),
    );
    this.assertTransportAllowed(url, addresses);

    // The deadline is authoritative; these per-phase limits are a backstop.
    const dispatcher = this.createDispatcher(addresses, {
      connectTimeoutMs: deadline.ms,
      headersTimeoutMs: deadline.ms,
      bodyTimeoutMs: deadline.ms,
      maxResponseBytes: this.maxResponseBytes,
      trustedCertificates: this.trustedCertificates,
    });

    let bodyConsumed = false;
    try {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const response = await dispatcher.request({
        origin: url.origin,
        path: `${url.pathname}${url.search}`,
        method,
        headers:
          payload === undefined
            ? headers
            : { 'content-type': 'application/json', ...headers },
        body: payload,
        signal: deadline.signal,
      });

      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        responseHeaders[name.toLowerCase()] = Array.isArray(value)
          ? value.join(', ')
          : value;
      }

      const location = responseHeaders['location'];
      if (REDIRECT_STATUSES.has(response.statusCode) && location) {
        // Discard (or, past undici's dump limit, cancel) the redirect body so
        // the hop is complete before its dispatcher is released.
        await response.body.dump({
          limit: REDIRECT_BODY_DUMP_LIMIT,
          signal: deadline.signal,
        });
        bodyConsumed = true;
        return { kind: 'redirect', status: response.statusCode, location };
      }

      const text = await response.body.text();
      bodyConsumed = true;
      return {
        kind: 'response',
        response: {
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: responseHeaders,
          body: this.parseBody(text, responseHeaders['content-type'], url),
        },
      };
    } finally {
      await releaseDispatcher(dispatcher, {
        graceful: bodyConsumed,
        onError: this.onCleanupError,
      });
    }
  }

  /**
   * STRICT requires TLS. Plain http is allowed only when every pinned address
   * is an explicit loopback test exemption.
   */
  private assertTransportAllowed(
    url: URL,
    addresses: readonly ResolvedAddress[],
  ): void {
    if (this.policy !== OutboundUrlPolicy.STRICT || url.protocol === 'https:')
      return;
    const exempt = addresses.every((entry) =>
      this.exemptAddresses.has(entry.address),
    );
    if (!exempt) {
      throw new ConnectorConfigurationError({
        message: `Connector URL must use https: ${describeTarget(url)}`,
        code: 'CONNECTOR_INSECURE_PROTOCOL',
      });
    }
  }

  private parseBody(
    text: string,
    contentType: string | undefined,
    url: URL,
  ): unknown {
    if (text.length === 0) return undefined;
    if (contentType === undefined || !JSON_MEDIA_TYPE.test(contentType)) {
      return text;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorInvalidResponseError({
        message: `Invalid JSON response from ${describeTarget(url)}`,
        code: 'CONNECTOR_INVALID_JSON',
      });
    }
  }

  private toConnectorError(
    error: unknown,
    context: {
      deadline: Deadline;
      method: string;
      target: string;
      timeoutMs: number;
    },
  ): ConnectorError {
    if (error instanceof ConnectorError) return error;
    const { deadline, method, target, timeoutMs } = context;

    if (deadline.expired) {
      return new ConnectorTimeoutError({
        message: `Request timed out after ${timeoutMs}ms: ${method} ${target}`,
        code: 'CONNECTOR_TIMEOUT',
        cause: error,
      });
    }
    if (deadline.cancelled) {
      return new ConnectorError({
        message: `Request cancelled: ${method} ${target}`,
        code: 'CONNECTOR_REQUEST_CANCELLED',
        category: ConnectorErrorCategory.CANCELLED,
        retryable: false,
        cause: error,
      });
    }

    const code = errorCodeOf(error);
    if (code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE') {
      return new ConnectorInvalidResponseError({
        message: `Response exceeded ${this.maxResponseBytes} bytes: ${method} ${target}`,
        code: 'CONNECTOR_RESPONSE_TOO_LARGE',
        cause: error,
      });
    }
    if (
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      return new ConnectorTimeoutError({
        message: `Request timed out: ${method} ${target}`,
        code: 'CONNECTOR_TIMEOUT',
        cause: error,
      });
    }
    if (code !== undefined && TLS_ERROR_CODE.test(code)) {
      return new ConnectorUnavailableError({
        message: `TLS verification failed for ${method} ${target}`,
        code: 'CONNECTOR_TLS_FAILURE',
        retryable: false,
        cause: error,
      });
    }
    return new ConnectorUnavailableError({
      message: `Network failure for ${method} ${target}`,
      code: 'CONNECTOR_NETWORK_FAILURE',
      cause: error,
    });
  }
}

/**
 * Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds.
 * Absent, malformed, negative or absurd (> 1 hour) values yield undefined.
 */
export function parseRetryAfterMs(
  value: string | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    // Every HTTP-date form starts with a day name; without this check V8's
    // lenient Date.parse would accept "-1" as a year.
    if (!/^[A-Za-z]{3}/.test(trimmed)) return undefined;
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    ms = Math.max(0, date - now);
  }
  return Number.isFinite(ms) && ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
}

/**
 * Send a request and require a successful 2xx JSON (or empty) response.
 * Throws a structured ConnectorError for auth, not-found, rate-limited,
 * server, and invalid responses. Messages carry method, origin and path only:
 * no query strings, credentials, or upstream response text (which may echo
 * customer data).
 */
export async function sendJson(
  request: RestRequest,
  client?: RestHttpClient,
): Promise<RestResponse> {
  const http =
    client ?? new RestHttpClient({ defaultTimeoutMs: request.timeoutMs });
  const response = await http.send(request);
  let target: string;
  try {
    target = describeTarget(new URL(request.url));
  } catch {
    target = '<invalid url>';
  }
  const label = `${request.method} ${target}`;

  if (response.ok) {
    if (typeof response.body === 'string') {
      throw new ConnectorInvalidResponseError({
        message: `Expected a JSON response from ${label}`,
        code: 'CONNECTOR_UNEXPECTED_CONTENT_TYPE',
      });
    }
    return response;
  }

  const status = response.status;
  const retryAfterMs = parseRetryAfterMs(response.headers['retry-after']);

  if (status === 401) {
    throw new ConnectorUnauthorizedError({
      message: `Authentication failed for ${label} (401)`,
      code: 'CONNECTOR_UNAUTHORIZED',
    });
  }
  if (status === 403) {
    throw new ConnectorError({
      message: `Authorization failed for ${label} (403)`,
      code: 'CONNECTOR_FORBIDDEN',
      category: ConnectorErrorCategory.AUTHORIZATION,
      retryable: false,
    });
  }
  if (status === 404) {
    throw new ConnectorNotFoundError({
      message: `Resource not found: ${label}`,
      code: 'CONNECTOR_NOT_FOUND',
    });
  }
  if (status === 429) {
    throw new ConnectorError({
      message: `Rate limited by upstream: ${label} (429)`,
      code: 'CONNECTOR_RATE_LIMITED',
      category: ConnectorErrorCategory.RATE_LIMITED,
      retryable: true,
      retryAfterMs,
    });
  }
  if (status === 408 || (status >= 500 && status !== 501)) {
    throw new ConnectorUnavailableError({
      message: `Upstream unavailable for ${label} (${status})`,
      code: 'CONNECTOR_UPSTREAM_ERROR',
      retryable: true,
      retryAfterMs,
    });
  }
  throw new ConnectorError({
    message: `Request failed for ${label} (${status})`,
    code: 'CONNECTOR_REQUEST_FAILED',
    category:
      status === 400 || status === 409 || status === 422
        ? ConnectorErrorCategory.VALIDATION
        : ConnectorErrorCategory.UNKNOWN,
    retryable: false,
  });
}
