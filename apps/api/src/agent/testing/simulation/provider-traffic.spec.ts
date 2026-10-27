import { describe, expect, it } from 'vitest';
import {
  classifyFetchError,
  classifyResponse,
  classifyRun,
  LaneExhaustedError,
  LaneTraffic,
  parseDurationMs,
  type TrafficEvent,
} from './provider-traffic.js';

const headers = (values: Record<string, string>): Headers =>
  new Headers(values);
const groq429 = JSON.stringify({
  error: {
    message: 'Rate limit reached for model on tokens per minute (TPM)',
    type: 'tokens',
    code: 'rate_limit_exceeded',
  },
});

describe('classification from status, headers and error body (fixtures)', () => {
  it('Groq 429 per minute: requests left, short token reset, retry-after seconds', () => {
    const v = classifyResponse({
      provider: 'groq',
      status: 429,
      headers: headers({
        'retry-after': '7',
        'x-ratelimit-remaining-requests': '812',
        'x-ratelimit-remaining-tokens': '0',
        'x-ratelimit-reset-tokens': '7.66s',
        'x-ratelimit-reset-requests': '2m59.56s',
      }),
      body: groq429,
    });
    expect(v).toMatchObject({
      kind: 'throttle',
      window: 'minute',
      retryAfterMs: 7_000,
      code: 'rate_limit_exceeded',
    });
  });

  it('Groq 429 per day: no requests left, or the body names the daily limit', () => {
    expect(
      classifyResponse({
        provider: 'groq',
        status: 429,
        headers: headers({
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-reset-requests': '6h12m3s',
        }),
        body: groq429,
      }),
    ).toMatchObject({ kind: 'quota', window: 'day', retryAfterMs: 22_323_000 });
    expect(
      classifyResponse({
        provider: 'groq',
        status: 429,
        headers: headers({ 'x-ratelimit-remaining-requests': '40' }),
        body: JSON.stringify({
          error: {
            message: 'Rate limit reached on tokens per day (TPD)',
            code: 'rate_limit_exceeded',
          },
        }),
      }),
    ).toMatchObject({ kind: 'quota', window: 'day' });
  });

  it('Gemini 429 per day (PerDay quota id) vs per minute (retryDelay)', () => {
    const perDay = JSON.stringify([
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              violations: [
                {
                  quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(
      classifyResponse({
        provider: 'gemini',
        status: 429,
        headers: headers({}),
        body: perDay,
      }),
    ).toMatchObject({ kind: 'quota', window: 'day', code: '429' });
    const perMinute = JSON.stringify([
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { retryDelay: '23s' },
            {
              violations: [
                {
                  quotaId:
                    'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(
      classifyResponse({
        provider: 'gemini',
        status: 429,
        headers: headers({}),
        body: perMinute,
      }),
    ).toMatchObject({
      kind: 'throttle',
      window: 'minute',
      retryAfterMs: 23_000,
    });
  });

  it('OpenRouter free daily cap vs per-minute limit, and an error inside an HTTP 200', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'Rate limit exceeded',
        metadata: { error_type: 'rate_limit_exceeded' },
      },
    });
    const tomorrow = String(Date.now() + 10 * 3_600_000);
    expect(
      classifyResponse({
        provider: 'openrouter',
        status: 429,
        headers: headers({
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': tomorrow,
        }),
        body,
      }),
    ).toMatchObject({ kind: 'quota', window: 'day' });
    expect(
      classifyResponse({
        provider: 'openrouter',
        status: 429,
        headers: headers({ 'x-ratelimit-remaining': '3', 'retry-after': '20' }),
        body,
      }),
    ).toMatchObject({
      kind: 'throttle',
      window: 'minute',
      retryAfterMs: 20_000,
    });
    expect(
      classifyResponse({
        provider: 'openrouter',
        status: 200,
        headers: headers({}),
        body: JSON.stringify({
          error: { code: 502, message: 'Provider returned error' },
        }),
      }),
    ).toMatchObject({ kind: 'transient', status: 502 });
  });

  it('Mistral 429 has no window: throttle of unknown window, with the redacted body code', () => {
    const body = JSON.stringify({
      object: 'error',
      message: 'Requests rate limit exceeded',
      type: 'rate_limit_error',
      param: null,
      code: '1300',
    });
    expect(
      classifyResponse({
        provider: 'mistral',
        status: 429,
        headers: headers({}),
        body,
      }),
    ).toMatchObject({ kind: 'throttle', window: 'unknown', code: '1300' });
  });

  it('5xx and 408 are transient; timeout and network errors are transient', () => {
    expect(
      classifyResponse({
        provider: 'groq',
        status: 503,
        headers: headers({}),
        body: 'Service Unavailable',
      }),
    ).toMatchObject({ kind: 'transient', status: 503 });
    expect(
      classifyResponse({
        provider: 'gemini',
        status: 408,
        headers: headers({}),
        body: '',
      }),
    ).toMatchObject({ kind: 'transient' });
    expect(
      classifyFetchError(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      ),
    ).toEqual({ kind: 'transient', code: 'timeout' });
    expect(classifyFetchError(new TypeError('fetch failed'))).toEqual({
      kind: 'transient',
      code: 'network',
    });
  });

  it('strict-JSON 400 is MODEL-FORMAT; other 400s are client errors; 402 and billing are auth_billing', () => {
    expect(
      classifyResponse({
        provider: 'groq',
        status: 400,
        headers: headers({}),
        body: JSON.stringify({
          error: {
            message: 'Failed to generate JSON. Please adjust your prompt.',
            code: 'json_validate_failed',
          },
        }),
      }),
    ).toMatchObject({ kind: 'format', code: 'json_validate_failed' });
    expect(
      classifyResponse({
        provider: 'groq',
        status: 400,
        headers: headers({}),
        body: JSON.stringify({
          error: {
            message: 'model is required',
            code: 'invalid_request_error',
          },
        }),
      }),
    ).toMatchObject({ kind: 'client_error' });
    expect(
      classifyResponse({
        provider: 'openrouter',
        status: 402,
        headers: headers({}),
        body: '{}',
      }),
    ).toMatchObject({ kind: 'auth_billing' });
    expect(
      classifyResponse({
        provider: 'gemini',
        status: 400,
        headers: headers({}),
        body: JSON.stringify({
          error: {
            status: 'FAILED_PRECONDITION',
            message: 'billing not enabled',
          },
        }),
      }),
    ).toMatchObject({ kind: 'auth_billing' });
  });

  it('parses provider durations', () => {
    expect(parseDurationMs('7.66s')).toBe(7_660);
    expect(parseDurationMs('2m59.56s')).toBe(179_560);
    expect(parseDurationMs('1h2m3s')).toBe(3_723_000);
    expect(parseDurationMs('120ms')).toBe(120);
    expect(parseDurationMs('30')).toBe(30_000);
    expect(parseDurationMs(null)).toBeUndefined();
  });
});

describe('lane pacing (amendment 4)', () => {
  const response = (
    status: number,
    h: Record<string, string> = {},
    body = '{}',
  ): Response => new Response(body, { status, headers: h });

  it('waits out a per-minute throttle below the turn timeout and continues', async () => {
    const slept: number[] = [];
    const replies = [
      response(
        429,
        { 'retry-after': '5', 'x-ratelimit-remaining-requests': '900' },
        groq429,
      ),
      response(200),
    ];
    const lane = new LaneTraffic({
      provider: 'groq',
      fetchImpl: (): Promise<Response> => Promise.resolve(replies.shift()!),
      sleep: (ms): Promise<void> => Promise.resolve(void slept.push(ms)),
      maxWaitMs: 20_000,
    });
    expect((await lane.fetch('https://x.invalid')).status).toBe(200);
    expect(slept).toEqual([5_000]);
    expect(lane.exhausted).toBeUndefined();
    expect(lane.events.map((e) => [e.kind, e.final])).toEqual([
      ['throttle', false],
      ['ok', true],
    ]);
  });

  it('does not wait longer than allowed; the throttle is final and the lane continues', async () => {
    const lane = new LaneTraffic({
      provider: 'groq',
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(
          response(
            429,
            { 'retry-after': '45', 'x-ratelimit-remaining-requests': '900' },
            groq429,
          ),
        ),
      sleep: (): Promise<void> => Promise.resolve(),
      maxWaitMs: 20_000,
    });
    expect((await lane.fetch('https://x.invalid')).status).toBe(429);
    expect(lane.events.at(-1)).toMatchObject({ kind: 'throttle', final: true });
    expect(lane.exhausted).toBeUndefined();
  });

  it('stops the lane on a per-day quota: later calls throw before any request', async () => {
    let calls = 0;
    const lane = new LaneTraffic({
      provider: 'groq',
      fetchImpl: (): Promise<Response> => (
        calls++,
        Promise.resolve(
          response(429, { 'x-ratelimit-remaining-requests': '0' }, groq429),
        )
      ),
      sleep: (): Promise<void> => Promise.resolve(),
    });
    expect((await lane.fetch('https://x.invalid')).status).toBe(429);
    expect(lane.exhausted).toMatchObject({ kind: 'quota', window: 'day' });
    lane.takeEvents();
    await expect(lane.fetch('https://x.invalid')).rejects.toBeInstanceOf(
      LaneExhaustedError,
    );
    expect(calls).toBe(1);
    // The run that hits the stop still records it, so it is classified INFRA.
    expect(classifyRun(false, lane.takeEvents())).toMatchObject({
      class: 'INFRA',
      reason: expect.stringMatching(/^quota:day/u) as unknown as string,
    });
  });

  it('escalates repeated throttles of unknown window (Mistral) to a stop', async () => {
    const body = JSON.stringify({ type: 'rate_limit_error', code: '1300' });
    const lane = new LaneTraffic({
      provider: 'mistral',
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(response(429, {}, body)),
      sleep: (): Promise<void> => Promise.resolve(),
      maxRetries: 10,
      escalateAfterUnknownThrottles: 3,
    });
    await lane.fetch('https://x.invalid');
    expect(lane.exhausted).toMatchObject({ kind: 'quota', window: 'unknown' });
  });

  it('retries a transient error once', async () => {
    const replies = [response(503), response(200)];
    const lane = new LaneTraffic({
      provider: 'groq',
      fetchImpl: (): Promise<Response> => Promise.resolve(replies.shift()!),
      sleep: (): Promise<void> => Promise.resolve(),
    });
    expect((await lane.fetch('https://x.invalid')).status).toBe(200);
  });
});

describe('run classification (amendment 2)', () => {
  const event = (
    kind: TrafficEvent['kind'],
    final: boolean,
    extra: Partial<TrafficEvent> = {},
  ): TrafficEvent => ({ kind, final, at: 0, ...extra });

  it('a passed run is AGENT even if throttles were waited out', () => {
    expect(
      classifyRun(true, [event('throttle', false), event('ok', true)]),
    ).toEqual({ class: 'AGENT' });
  });
  it('a failed run with an unrecovered provider problem is INFRA, with the reason', () => {
    expect(
      classifyRun(false, [
        event('quota', true, { window: 'day', code: 'rate_limit_exceeded' }),
      ]),
    ).toEqual({ class: 'INFRA', reason: 'quota:day:rate_limit_exceeded' });
    expect(
      classifyRun(false, [event('transient', true, { code: 'network' })]),
    ).toEqual({ class: 'INFRA', reason: 'transient:network' });
    expect(classifyRun(false, [], ['TURN_TIMEOUT'])).toEqual({
      class: 'INFRA',
      reason: 'timeout',
    });
  });
  it('a failed run with a rejected output format is MODEL_FORMAT; otherwise AGENT', () => {
    expect(
      classifyRun(false, [
        event('format', true, { code: 'json_validate_failed' }),
      ]),
    ).toEqual({ class: 'MODEL_FORMAT', reason: 'format:json_validate_failed' });
    expect(classifyRun(false, [event('ok', true)])).toEqual({ class: 'AGENT' });
  });
});
