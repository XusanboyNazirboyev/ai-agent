/**
 * Provider traffic for free-tier baseline runs (ADR 026 slice 1c,
 * amendments 3-4). Wraps the `fetch` of the OpenAI-compatible adapter (it
 * accepts one), so v1 code is unchanged. It classifies every provider
 * response from status, headers and error body (never from reply text),
 * waits out per-minute throttling when the wait fits under the turn timeout,
 * and marks the lane exhausted on a per-day quota so the runner stops and
 * keeps partial results.
 *
 * Signals, from official docs read 2026-10-26 (details in the report):
 * - Groq (console.groq.com/docs/rate-limits): `x-ratelimit-*-requests` are
 *   the per-DAY request window, `x-ratelimit-*-tokens` the per-MINUTE token
 *   window; `retry-after` (seconds) only on 429.
 * - OpenRouter (openrouter.ai/docs/api-reference/limits, /errors): 429 with
 *   `X-RateLimit-Remaining/Reset`, `Retry-After` when hinted; errors may come
 *   as HTTP 200 with an `error` body.
 * - Gemini (ai.google.dev/gemini-api/docs/troubleshooting, /api-errors): 429
 *   RESOURCE_EXHAUSTED; per-day vs per-minute details are not reliably
 *   documented (parsed defensively: PerDay quota ids, `quota_exceeded`).
 * - Mistral (docs.mistral.ai/resources/error-glossary): body
 *   `{type, code}`; no rate-limit headers documented, window unknown.
 */
export type TrafficKind =
  | 'ok'
  | 'throttle' // per-minute/second: wait and continue
  | 'quota' // per-day/month or billing exhaustion: stop the lane
  | 'transient' // 408/5xx/timeout/network
  | 'format' // provider rejected the model's output format (strict JSON / schema)
  | 'auth_billing' // 401/402/403/billing precondition: stop, needs a person
  | 'client_error'; // other 4xx: a request bug, not infra

export interface TrafficVerdict {
  readonly kind: TrafficKind;
  readonly window?: 'second' | 'minute' | 'day' | 'month' | 'unknown';
  readonly retryAfterMs?: number;
  /** Provider error code/type, redacted to [A-Za-z0-9_.-]. */
  readonly code?: string;
  readonly status?: number;
}

export interface HeaderBag {
  get(name: string): string | null;
}

const safe = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value)
        .replace(/[^A-Za-z0-9_.-]/gu, '')
        .slice(0, 60) || undefined
    : undefined;

/** Groq-style durations: "7.66s", "2m59.56s", "1h2m3s", "120ms". */
export function parseDurationMs(text: string | null): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (/^\d+(\.\d+)?$/u.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  let total = 0;
  let matched = false;
  for (const m of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gu)) {
    matched = true;
    const n = Number(m[1]);
    total +=
      m[2] === 'h'
        ? n * 3_600_000
        : m[2] === 'm'
          ? n * 60_000
          : m[2] === 's'
            ? n * 1000
            : n;
  }
  return matched ? Math.round(total) : undefined;
}

function parseBody(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed[0] as Record<string, unknown>;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const FORMAT_PATTERN =
  /json_validate_failed|failed to generate json|response_format|json schema|json_schema|structured output|tool_use_failed/iu;

export function classifyResponse(input: {
  provider: string;
  status: number;
  headers: HeaderBag;
  body: string;
}): TrafficVerdict {
  const { provider, status, headers } = input;
  const parsed = parseBody(input.body);
  const error = (parsed?.error ?? parsed) as
    Record<string, unknown> | undefined;
  const code = safe(error?.code) ?? safe(error?.status) ?? safe(error?.type);
  const retryAfter = parseDurationMs(headers.get('retry-after'));

  // OpenRouter can report an error inside an HTTP 200 body.
  if (status >= 200 && status < 300) {
    if (provider === 'openrouter' && parsed?.error && !parsed.choices) {
      const inner = Number((parsed.error as Record<string, unknown>).code);
      return classifyResponse({
        ...input,
        status: Number.isFinite(inner) && inner >= 400 ? inner : 502,
      });
    }
    return { kind: 'ok', status };
  }

  if (status === 429) {
    if (provider === 'groq') {
      // `*-requests` headers are the per-day window; `*-tokens` the per-minute one.
      const remainingRequests = headers.get('x-ratelimit-remaining-requests');
      const resetRequests = parseDurationMs(
        headers.get('x-ratelimit-reset-requests'),
      );
      if (
        remainingRequests === '0' ||
        /per day|\(TPD\)|\(RPD\)/iu.test(input.body)
      )
        return {
          kind: 'quota',
          window: 'day',
          retryAfterMs: resetRequests,
          code,
          status,
        };
      return {
        kind: 'throttle',
        window: 'minute',
        retryAfterMs:
          retryAfter ??
          parseDurationMs(headers.get('x-ratelimit-reset-tokens')),
        code,
        status,
      };
    }
    if (provider === 'openrouter') {
      const remaining = headers.get('x-ratelimit-remaining');
      const reset = Number(headers.get('x-ratelimit-reset'));
      const untilReset =
        Number.isFinite(reset) && reset > 0 ? reset - Date.now() : undefined;
      if (
        remaining === '0' &&
        untilReset !== undefined &&
        untilReset > 3_600_000
      )
        return {
          kind: 'quota',
          window: 'day',
          retryAfterMs: untilReset,
          code,
          status,
        };
      return {
        kind: 'throttle',
        window: 'minute',
        retryAfterMs: retryAfter ?? untilReset,
        code,
        status,
      };
    }
    const text = input.body;
    if (
      /PerDay|per day|quota_exceeded|insufficient_quota|credit_balance_exhausted/iu.test(
        text,
      )
    )
      return {
        kind: 'quota',
        window: 'day',
        retryAfterMs: retryAfter,
        code,
        status,
      };
    if (/per ?month|tokens per month/iu.test(text))
      return {
        kind: 'quota',
        window: 'month',
        retryAfterMs: retryAfter,
        code,
        status,
      };
    const retryDelay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/u.exec(text);
    return {
      kind: 'throttle',
      window: /PerMinute|per minute|rate_limit_exceeded/iu.test(text)
        ? 'minute'
        : 'unknown',
      retryAfterMs:
        retryAfter ??
        (retryDelay ? Math.round(Number(retryDelay[1]) * 1000) : undefined),
      code,
      status,
    };
  }
  if (status === 402 || status === 401 || status === 403)
    return { kind: 'auth_billing', code, status };
  if (status === 400 && /failed_precondition|billing/iu.test(input.body))
    return { kind: 'auth_billing', code, status };
  if (status === 400 || status === 422)
    return FORMAT_PATTERN.test(input.body)
      ? { kind: 'format', code, status }
      : { kind: 'client_error', code, status };
  if (status === 408 || status >= 500 || status === 498 || status === 499)
    return { kind: 'transient', retryAfterMs: retryAfter, code, status };
  return { kind: 'client_error', code, status };
}

/** A thrown fetch error (no HTTP response). */
export function classifyFetchError(error: unknown): TrafficVerdict {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError')
    return { kind: 'transient', code: 'timeout' };
  return { kind: 'transient', code: 'network' };
}

export interface TrafficEvent extends TrafficVerdict {
  readonly at: number;
  /** True for the final verdict of one logical request (after waits/retries). */
  readonly final: boolean;
}

/** Thrown when a lane's quota is exhausted; the runner stops the lane. */
export class LaneExhaustedError extends Error {
  constructor(readonly verdict: TrafficVerdict) {
    super(`provider quota exhausted (${verdict.window ?? 'unknown'} window)`);
    this.name = 'LaneExhaustedError';
  }
}

/**
 * The paced `fetch` of one lane. Throttles with a known wait <= maxWaitMs are
 * waited out and retried; repeated throttles of unknown window escalate to
 * quota; transient errors are retried once; a quota stops the lane.
 */
export class LaneTraffic {
  readonly events: TrafficEvent[] = [];
  exhausted?: TrafficVerdict;
  private unknownThrottlesInARow = 0;

  constructor(
    private readonly options: {
      provider: string;
      fetchImpl?: typeof fetch;
      maxWaitMs?: number;
      maxRetries?: number;
      escalateAfterUnknownThrottles?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    },
  ) {}

  /** Events since the last call (one run's worth). */
  takeEvents(): TrafficEvent[] {
    return this.events.splice(0, this.events.length);
  }

  readonly fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (this.exhausted) {
      // Recorded so the run that hit the stop is classified INFRA, not AGENT.
      this.events.push({
        ...this.exhausted,
        at: (this.options.now ?? Date.now)(),
        final: true,
      });
      throw new LaneExhaustedError(this.exhausted);
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep =
      this.options.sleep ??
      ((ms: number): Promise<void> =>
        new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.options.now ?? Date.now;
    const maxWait = this.options.maxWaitMs ?? 20_000;
    const maxRetries = this.options.maxRetries ?? 3;
    const escalate = this.options.escalateAfterUnknownThrottles ?? 4;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(input, init);
      } catch (error) {
        const verdict = classifyFetchError(error);
        const last = attempt >= 1;
        this.events.push({ ...verdict, at: now(), final: last });
        if (last) throw error;
        await sleep(1_000);
        continue;
      }
      const body =
        response.ok && this.options.provider !== 'openrouter'
          ? ''
          : await response.clone().text();
      const verdict = classifyResponse({
        provider: this.options.provider,
        status: response.status,
        headers: response.headers,
        body,
      });
      if (verdict.kind === 'throttle') {
        this.unknownThrottlesInARow =
          verdict.window === 'unknown' ? this.unknownThrottlesInARow + 1 : 0;
        if (this.unknownThrottlesInARow >= escalate) {
          this.exhausted = { ...verdict, kind: 'quota', window: 'unknown' };
          this.events.push({ ...this.exhausted, at: now(), final: true });
          return response;
        }
        const wait =
          verdict.retryAfterMs ?? Math.min(maxWait, 2_000 * 2 ** attempt);
        if (wait <= maxWait && attempt < maxRetries) {
          this.events.push({ ...verdict, at: now(), final: false });
          await sleep(wait);
          continue;
        }
      } else if (verdict.kind !== 'ok') this.unknownThrottlesInARow = 0;
      if (verdict.kind === 'transient' && attempt < 1) {
        this.events.push({ ...verdict, at: now(), final: false });
        await sleep(Math.min(maxWait, verdict.retryAfterMs ?? 2_000));
        continue;
      }
      if (verdict.kind === 'quota' || verdict.kind === 'auth_billing')
        this.exhausted = verdict;
      if (verdict.kind === 'ok') this.unknownThrottlesInARow = 0;
      this.events.push({ ...verdict, at: now(), final: true });
      return response;
    }
  };
}

/**
 * Classifies one finished run (amendment 2): a passed run counts as AGENT;
 * a failed run with an unrecovered provider problem is INFRA; a failed run
 * whose provider rejected the output format is MODEL_FORMAT; else AGENT.
 */
export function classifyRun(
  passed: boolean,
  events: readonly TrafficEvent[],
  turnFailureCodes: readonly (string | null)[] = [],
): { class: 'AGENT' | 'MODEL_FORMAT' | 'INFRA'; reason?: string } {
  if (passed) return { class: 'AGENT' };
  const finals = events.filter((e) => e.final && e.kind !== 'ok');
  const infra = finals.find((e) =>
    ['quota', 'throttle', 'transient', 'auth_billing'].includes(e.kind),
  );
  if (infra)
    return {
      class: 'INFRA',
      reason: `${infra.kind}${infra.window ? `:${infra.window}` : ''}${infra.code ? `:${infra.code}` : ''}`,
    };
  if (turnFailureCodes.some((c) => c === 'TURN_TIMEOUT' || c === 'LLM_TIMEOUT'))
    return { class: 'INFRA', reason: 'timeout' };
  const format = finals.find((e) => e.kind === 'format');
  if (format)
    return {
      class: 'MODEL_FORMAT',
      reason: `format${format.code ? `:${format.code}` : ''}`,
    };
  return { class: 'AGENT' };
}
