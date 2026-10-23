import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runAgentTurn } from '../../core/agent/agent-turn.js';
import { TurnBudget } from '../../core/llm/budget.js';
import { LlmError } from '../../core/llm/llm-provider.js';
import { MeteredLlm, type LlmUsageEntry } from '../../core/llm/metered-llm.js';
import { pricingFor } from '../../core/llm/pricing.js';
import { EDUCATION_PACK } from '../../packs/education/education.pack.js';
import { UZ_LATN } from '../../locales/locale-packs.js';
import {
  educationConnector,
  LOCALES,
  TEST_LIMITS,
} from '../../agent/testing/agent-harness.js';
import { PRICING_CATALOG } from '../pricing-catalog.js';
import { backoffDelayMs, parseRetryAfterMs } from '../retry.js';
import {
  ClientRateLimiter,
  RateLimitedLlmProvider,
} from '../rate-limited-provider.js';
import {
  errorFromResponse,
  OpenAiCompatibleLlmProvider,
  type OpenAiCompatibleOptions,
} from './openai-compatible-provider.js';

/**
 * Conformance tests on handwritten Chat Completions fixtures shaped after
 * the OpenAI reference examples (no network). Each fake response is a
 * plain JSON body plus status and headers.
 */

type Reply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  hang?: boolean;
};

function transport(replies: Reply[]): {
  fetch: typeof fetch;
  requests: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }>;
} {
  const requests: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const fake = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('no fixture left');
    if (reply.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  return { fetch: fake as typeof fetch, requests };
}

function provider(
  replies: Reply[],
  overrides: Partial<OpenAiCompatibleOptions> = {},
): {
  llm: OpenAiCompatibleLlmProvider;
  requests: ReturnType<typeof transport>['requests'];
  sleep: ReturnType<typeof vi.fn>;
} {
  const { fetch, requests } = transport(replies);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const llm = new OpenAiCompatibleLlmProvider({
    baseUrl: 'https://llm.example.test/v1/',
    apiKey: 'test-placeholder-key',
    models: { FAST: 'fast-model', STRONG: 'strong-model' },
    structuredOutput: 'json_schema',
    maxTokensParam: 'max_tokens',
    requestTimeoutMs: 200,
    maxRetries: 2,
    fetch,
    sleep,
    random: (): number => 0.5,
    ...overrides,
  });
  return { llm, requests, sleep };
}

const completion = (
  message: Record<string, unknown>,
  finish = 'stop',
  usage: Record<string, unknown> | null = {
    prompt_tokens: 82,
    completion_tokens: 17,
    total_tokens: 99,
    prompt_tokens_details: { cached_tokens: 2 },
  },
): Record<string, unknown> => ({
  id: 'chatcmpl-fixture',
  object: 'chat.completion',
  model: 'strong-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', ...message },
      finish_reason: finish,
    },
  ],
  ...(usage ? { usage } : {}),
});

const toolRequest = {
  tier: 'STRONG' as const,
  purpose: 'respond' as const,
  system: 'system rules',
  messages: [{ role: 'user' as const, text: 'IELTS?' }],
  tools: [
    {
      name: 'list_offers',
      description: 'List offers',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['itemId'],
        properties: { itemId: { type: 'string' } },
      },
    },
  ],
  maxOutputTokens: 300,
};

const structuredRequest = {
  tier: 'FAST' as const,
  purpose: 'extract' as const,
  system: 'extract',
  messages: [{ role: 'user' as const, text: 'hello' }],
  schemaName: 'turn_extraction',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  },
  schema: z.object({ ok: z.boolean() }).strict(),
  maxOutputTokens: 100,
};

describe('OpenAI-compatible adapter: request mapping', () => {
  it('posts Chat Completions with bearer auth, tools and the configured ceiling', async () => {
    const { llm, requests } = provider([
      { body: completion({ content: 'hi' }) },
    ]);
    await llm.generateWithTools({
      ...toolRequest,
      messages: [
        { role: 'user', text: 'IELTS?' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'list_offers', input: { itemId: 'x' } },
          ],
        },
        {
          role: 'tool_results',
          results: [
            { toolCallId: 'call_1', content: '{"offers":[]}', isError: false },
          ],
        },
      ],
    });
    const [sent] = requests;
    expect(sent.url).toBe('https://llm.example.test/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer test-placeholder-key');
    expect(sent.body).toMatchObject({
      model: 'strong-model',
      max_tokens: 300,
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_offers',
            parameters: toolRequest.tools[0].inputSchema,
          },
        },
      ],
    });
    // tool_choice is never sent (auto is the default; Ollama rejects it).
    expect(sent.body).not.toHaveProperty('tool_choice');
    expect(sent.body).not.toHaveProperty('parallel_tool_calls');
    expect(sent.body.messages).toEqual([
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'IELTS?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'list_offers', arguments: '{"itemId":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"offers":[]}' },
    ]);
  });

  it('omits the key for local servers and supports max_completion_tokens', async () => {
    const { llm, requests } = provider(
      [{ body: completion({ content: 'hi' }) }],
      {
        apiKey: undefined,
        maxTokensParam: 'max_completion_tokens',
      },
    );
    await llm.generateWithTools({ ...toolRequest, singleToolCall: true });
    expect(requests[0].headers).not.toHaveProperty('authorization');
    expect(requests[0].body).toMatchObject({
      max_completion_tokens: 300,
      parallel_tool_calls: false,
    });
    expect(requests[0].body).not.toHaveProperty('max_tokens');
  });

  it('requests json_schema output, or json_object with the schema in the prompt', async () => {
    const schema = provider([{ body: completion({ content: '{"ok":true}' }) }]);
    const result = await schema.llm.generateStructured(structuredRequest);
    expect(result.value).toEqual({ ok: true });
    expect(schema.requests[0].body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'turn_extraction',
        schema: structuredRequest.jsonSchema,
        strict: true,
      },
    });
    const object = provider(
      [{ body: completion({ content: '{"ok":false}' }) }],
      {
        structuredOutput: 'json_object',
      },
    );
    await object.llm.generateStructured(structuredRequest);
    expect(object.requests[0].body.response_format).toEqual({
      type: 'json_object',
    });
    const system = (
      object.requests[0].body.messages as Array<{ content: string }>
    )[0];
    expect(system.content).toContain('"required":["ok"]');
  });
});

describe('OpenAI-compatible adapter: response mapping', () => {
  it('maps tool calls, ids, finish reasons and usage (cached tokens split out)', async () => {
    const { llm } = provider([
      {
        body: completion(
          {
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'list_offers',
                  arguments: '{"itemId":"mock:1"}',
                },
              },
            ],
          },
          'tool_calls',
        ),
      },
    ]);
    const result = await llm.generateWithTools(toolRequest);
    expect(result).toMatchObject({
      providerId: 'openai-compatible',
      model: 'strong-model',
      responseId: 'chatcmpl-fixture',
      stopReason: 'tool_calls',
      toolCalls: [
        { id: 'call_abc', name: 'list_offers', input: { itemId: 'mock:1' } },
      ],
      usage: {
        inputTokens: 80,
        cacheReadTokens: 2,
        outputTokens: 17,
      },
    });
    expect(result.usage.estimated).toBeUndefined();
  });

  it('keeps malformed tool arguments as a string so core validation rejects them', async () => {
    const { llm } = provider([
      {
        body: completion(
          {
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'list_offers', arguments: '{"itemId": ' },
              },
            ],
          },
          'tool_calls',
        ),
      },
    ]);
    const result = await llm.generateWithTools(toolRequest);
    expect(result.toolCalls[0].input).toBe('{"itemId": ');
  });

  it('estimates and flags usage when the server reports none', async () => {
    const { llm } = provider([
      { body: completion({ content: 'Salom' }, 'stop', null) },
    ]);
    const result = await llm.generateWithTools(toolRequest);
    expect(result.usage).toMatchObject({ estimated: true, cacheReadTokens: 0 });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('maps length, content_filter and refusal; validates structured output', async () => {
    const { llm } = provider([
      { body: completion({ content: '{"ok":tr' }, 'length') },
      { body: completion({ content: null, refusal: 'I cannot help' }) },
      { body: completion({ content: '{"ok":"yes"}' }) },
      { body: completion({ content: 'text' }, 'content_filter') },
    ]);
    expect(await llm.generateStructured(structuredRequest)).toMatchObject({
      failure: 'truncated',
      stopReason: 'max_tokens',
    });
    expect(await llm.generateStructured(structuredRequest)).toMatchObject({
      failure: 'refusal',
    });
    expect(await llm.generateStructured(structuredRequest)).toMatchObject({
      failure: 'malformed',
    });
    expect((await llm.generateWithTools(toolRequest)).stopReason).toBe(
      'refusal',
    );
  });

  it('rejects a malformed response body without retrying', async () => {
    const { llm, requests } = provider([{ body: { choices: [] } }]);
    await expect(llm.generateWithTools(toolRequest)).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
      retryable: false,
    });
    expect(requests).toHaveLength(1);
  });
});

describe('OpenAI-compatible adapter: errors and retries', () => {
  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const { llm, requests, sleep } = provider([
      {
        status: 429,
        headers: { 'retry-after': '2' },
        body: {
          error: {
            message: 'Rate limit reached for requests',
            type: 'requests',
            code: 'rate_limit_exceeded',
          },
        },
      },
      { body: completion({ content: 'ok' }) },
    ]);
    const result = await llm.generateWithTools(toolRequest);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(requests).toHaveLength(2);
  });

  it('treats quota exhaustion as final (no retry)', async () => {
    const { llm, requests } = provider([
      {
        status: 429,
        body: {
          error: {
            message: 'no credits',
            type: 'insufficient_quota',
            code: 'credit_balance_exhausted',
          },
        },
      },
    ]);
    await expect(llm.generateWithTools(toolRequest)).rejects.toMatchObject({
      code: 'LLM_QUOTA_EXHAUSTED',
      retryable: false,
    });
    expect(requests).toHaveLength(1);
  });

  it('retries 5xx with backoff and gives up after maxRetries', async () => {
    const { llm, requests, sleep } = provider([
      { status: 503, body: { error: { code: 'server_is_overloaded' } } },
      { status: 500 },
      { status: 502 },
    ]);
    await expect(llm.generateWithTools(toolRequest)).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });
    expect(requests).toHaveLength(3);
    expect(sleep).toHaveBeenNthCalledWith(
      1,
      backoffDelayMs(1, () => 0.5),
    );
    expect(sleep).toHaveBeenNthCalledWith(
      2,
      backoffDelayMs(2, () => 0.5),
    );
  });

  it('times out a hanging request and retries it as transient', async () => {
    const { llm, requests } = provider([
      { hang: true },
      { hang: true },
      { hang: true },
    ]);
    await expect(llm.generateWithTools(toolRequest)).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
    });
    expect(requests).toHaveLength(3);
  });

  it('never retries invalid payloads, unauthorized or unsupported features', async () => {
    for (const [status, body, code] of [
      [
        400,
        { error: { message: 'Invalid value for messages' } },
        'LLM_INVALID_REQUEST',
      ],
      [
        401,
        { error: { message: 'Incorrect API key provided' } },
        'LLM_AUTHENTICATION',
      ],
      [403, {}, 'LLM_AUTHENTICATION'],
      [
        400,
        { error: { message: 'This model does not support tools' } },
        'LLM_INVALID_REQUEST',
      ],
      [
        400,
        { error: { message: 'response_format json_schema is not supported' } },
        'LLM_INVALID_REQUEST',
      ],
    ] as const) {
      const { llm, requests } = provider([{ status, body }]);
      await expect(llm.generateWithTools(toolRequest)).rejects.toMatchObject({
        code,
        retryable: false,
      });
      expect(requests).toHaveLength(1);
    }
  });

  it('derives unsupported features from the capability table, before any request', async () => {
    const { llm, requests } = provider(
      [{ body: completion({ content: '{}' }) }],
      {
        capabilityOf: (model) =>
          model === 'strong-model'
            ? { tools: 'no', structured: 'none' }
            : { tools: 'yes', structured: 'json_object' },
      },
    );
    await expect(llm.generateWithTools(toolRequest)).rejects.toMatchObject({
      code: 'LLM_UNSUPPORTED_FEATURE',
      retryable: false,
    });
    await expect(
      llm.generateStructured({ ...structuredRequest, tier: 'STRONG' }),
    ).rejects.toMatchObject({ code: 'LLM_UNSUPPORTED_FEATURE' });
    expect(requests).toHaveLength(0);
    // json_object from the table overrides the configured default mode.
    await llm.generateStructured(structuredRequest);
    expect(requests[0].body.response_format).toEqual({ type: 'json_object' });
  });

  it('maps an unknown model (404) to a non-retryable failover-eligible code', async () => {
    const { llm, requests } = provider([
      {
        status: 404,
        body: { error: { message: 'x', code: 'model_not_found' } },
      },
    ]);
    await expect(llm.generateWithTools(toolRequest)).rejects.toMatchObject({
      code: 'LLM_UNSUPPORTED_FEATURE',
      retryable: false,
    });
    expect(requests).toHaveLength(1);
  });

  it('keeps error messages free of credentials', () => {
    const error = errorFromResponse(
      401,
      { error: { message: 'Bearer test-placeholder-key is wrong' } },
      null,
    );
    expect(error.message).not.toContain('test-placeholder-key');
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = new Date('2026-10-23T10:00:00Z');
    expect(parseRetryAfterMs('3', now)).toBe(3_000);
    expect(parseRetryAfterMs('Fri, 23 Oct 2026 10:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfterMs('garbage', now)).toBeUndefined();
    expect(backoffDelayMs(1, () => 0)).toBe(250);
    expect(backoffDelayMs(10, () => 1)).toBe(10_000);
  });

  it('routes quota exhaustion to the LLM_UNAVAILABLE handover, not GUARDRAIL', async () => {
    const { llm: raw } = provider([
      { status: 429, body: { error: { type: 'insufficient_quota' } } },
    ]);
    const pricing = PRICING_CATALOG.snapshot('local-free-2026-10-23');
    const budget = new TurnBudget(TEST_LIMITS, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    });
    const result = await runAgentTurn(
      {
        turnKey: 't',
        customerText: 'IELTS kerak',
        history: [],
        slots: {},
        supportedLocales: ['uz-Latn'],
        defaultLocale: 'uz-Latn',
        timeZone: 'Asia/Tashkent',
      },
      {
        pack: EDUCATION_PACK,
        locales: LOCALES,
        connector: educationConnector(),
        llm: new MeteredLlm(
          raw,
          pricing,
          budget,
          { record: async (): Promise<void> => undefined },
          {
            tenantId: 't',
            turnKey: 't',
          },
        ),
        toolTimeoutMs: 200,
        maxOutputTokens: { extract: 300, respond: 300 },
      },
    );
    expect(result).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'LLM_UNAVAILABLE',
      llmFailure: 'LLM_QUOTA_EXHAUSTED',
    });
    expect(result.reply).toBe(UZ_LATN.templates.handover.LLM_UNAVAILABLE);
  });
});

describe('client-side rate limiter', () => {
  function clock(): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    advance: (ms: number) => void;
  } {
    let t = 1_000_000;
    return {
      now: () => t,
      sleep: async (ms): Promise<void> => {
        t += ms;
      },
      advance: (ms): void => {
        t += ms;
      },
    };
  }

  it('waits for RPM capacity within maxWaitMs, otherwise refuses', async () => {
    const c = clock();
    const limiter = new ClientRateLimiter(
      { requestsPerMinute: 2, maxWaitMs: 60_000 },
      c.now,
      c.sleep,
    );
    await limiter.acquire(10);
    await limiter.acquire(10);
    const before = c.now();
    await limiter.acquire(10);
    expect(c.now() - before).toBe(60_000);
    const strict = new ClientRateLimiter(
      { requestsPerMinute: 1, maxWaitMs: 1_000 },
      c.now,
      c.sleep,
    );
    await strict.acquire(1);
    await expect(strict.acquire(1)).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
    });
  });

  it('bounds tokens per minute and requests per day', async () => {
    const c = clock();
    const tpm = new ClientRateLimiter(
      { tokensPerMinute: 1_000, maxWaitMs: 0 },
      c.now,
      c.sleep,
    );
    await tpm.acquire(600);
    await expect(tpm.acquire(600)).rejects.toBeInstanceOf(LlmError);
    await expect(tpm.acquire(5_000)).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
    });
    c.advance(60_001);
    await expect(tpm.acquire(600)).resolves.toBeUndefined();

    const rpd = new ClientRateLimiter(
      { requestsPerDay: 2, maxWaitMs: 0 },
      c.now,
      c.sleep,
    );
    await rpd.acquire(1);
    await rpd.acquire(1);
    await expect(rpd.acquire(1)).rejects.toMatchObject({
      code: 'LLM_QUOTA_EXHAUSTED',
    });
    c.advance(86_400_001);
    await expect(rpd.acquire(1)).resolves.toBeUndefined();
  });

  it('wraps a provider and refuses before any request leaves', async () => {
    const { llm, requests } = provider([
      { body: completion({ content: 'ok' }) },
    ]);
    const c = clock();
    const limited = new RateLimitedLlmProvider(
      llm,
      new ClientRateLimiter(
        { requestsPerDay: 1, maxWaitMs: 0 },
        c.now,
        c.sleep,
      ),
    );
    await limited.generateWithTools(toolRequest);
    await expect(limited.generateWithTools(toolRequest)).rejects.toMatchObject({
      code: 'LLM_QUOTA_EXHAUSTED',
    });
    expect(requests).toHaveLength(1);
  });
});

describe('zero-cost models are still bounded by tokens', () => {
  it('prices free models at 0 and stops on the turn token cap', async () => {
    const gemini = PRICING_CATALOG.snapshot('gemini-free-2026-10-23');
    expect(pricingFor(gemini, 'gemini-3.8-flash')).toMatchObject({
      free: true,
    });
    expect(() => pricingFor(gemini, 'gemini-4-argon')).toThrow(/No pricing/);
    const local = PRICING_CATALOG.snapshot('local-free-2026-10-23');
    expect(pricingFor(local, 'qwen3:8b').free).toBe(true);

    const replies: Reply[] = Array.from({ length: 10 }, () => ({
      body: completion({ content: 'still going' }),
    }));
    const { llm, requests } = provider(replies, {
      models: { FAST: 'qwen3:8b', STRONG: 'qwen3:8b' },
    });
    const entries: LlmUsageEntry[] = [];
    const budget = new TurnBudget(
      { ...TEST_LIMITS, maxCallsPerTurn: 10, maxTurnTokens: 1_500 },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const metered = new MeteredLlm(
      llm,
      local,
      budget,
      { record: async (entry): Promise<void> => void entries.push(entry) },
      { tenantId: 't', turnKey: 't' },
    );
    let stop: unknown;
    for (let i = 0; i < 10 && !stop; i++) {
      await metered
        .withTools({ ...toolRequest, maxOutputTokens: 200 })
        .catch((error: unknown) => {
          stop = error;
        });
    }
    expect(stop).toMatchObject({ reason: 'TURN_TOKEN_LIMIT' });
    expect(requests.length).toBeLessThan(10);
    expect(entries.every((entry) => entry.costNano === 0)).toBe(true);
    expect(budget.snapshot.spentNano).toBe(0);
    expect(budget.snapshot.tokensUsed).toBeGreaterThan(0);
  });

  it('stops on the conversation token cap from the stored ledger', () => {
    const budget = new TurnBudget(
      { ...TEST_LIMITS, maxConversationTokens: 10_000 },
      {
        conversationSpentNano: 0,
        tenantMonthSpentNano: 0,
        conversationTokensUsed: 9_900,
      },
    );
    expect(() => budget.reserve(0, 10, 200)).toThrow(
      expect.objectContaining({ reason: 'CONVERSATION_TOKEN_LIMIT' }),
    );
  });
});
