import { describe, expect, it, vi } from 'vitest';
import { chunkText } from '../core/knowledge/chunking.js';
import { assertUniformVectors } from '../core/knowledge/embedding.js';
import { TurnBudget } from '../core/llm/budget.js';
import { LlmError } from '../core/llm/llm-provider.js';
import { MeteredLlm, type LlmUsageEntry } from '../core/llm/metered-llm.js';
import { PRICING_CATALOG } from '../llm/pricing-catalog.js';
import { HashingEmbeddingProvider } from '../llm/embeddings/hashing-embedding-provider.js';
import { OpenAiCompatibleEmbeddingProvider } from '../llm/embeddings/openai-compatible-embedding-provider.js';
import { TEST_LIMITS } from './testing/agent-harness.js';

describe('chunking', () => {
  it('keeps short paragraphs together and splits long ones with overlap', () => {
    expect(chunkText('One.\n\nTwo.\n\nThree.')).toEqual(['One. Two. Three.']);
    const long = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i} is here.`,
    ).join(' ');
    const chunks = chunkText(long, { maxChars: 300, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(300);
    // Overlap: the end of one chunk reappears at the start of the next.
    const tail = chunks[0].slice(-30);
    expect(chunks[1]).toContain(
      tail.slice(tail.indexOf(' ') + 1, tail.indexOf(' ') + 12),
    );
    // Nothing is lost.
    for (let i = 0; i < 60; i++)
      expect(chunks.join(' ')).toContain(`number ${i} is`);
  });

  it('is deterministic and rejects unusable options', () => {
    expect(chunkText('a\n\nb')).toEqual(chunkText('a\n\nb'));
    expect(chunkText('   \n\n  ')).toEqual([]);
    expect(() => chunkText('x', { maxChars: 50, overlapChars: 0 })).toThrow(
      RangeError,
    );
    expect(() => chunkText('x', { maxChars: 200, overlapChars: 150 })).toThrow(
      RangeError,
    );
  });
});

describe('embedding shape checks', () => {
  it('accepts uniform finite vectors and rejects the rest', () => {
    expect(
      assertUniformVectors(
        [
          [1, 2],
          [3, 4],
        ],
        2,
      ),
    ).toBe(2);
    expect(() => assertUniformVectors([[1, 2]], 2)).toThrow();
    expect(() => assertUniformVectors([[1, 2], [3]], 2)).toThrow();
    expect(() => assertUniformVectors([[Number.NaN]], 1)).toThrow();
    expect(() => assertUniformVectors([[]], 1)).toThrow();
  });

  it('hashing embedder is deterministic, normalized, and related for shared words only', async () => {
    const e = new HashingEmbeddingProvider(64);
    const { vectors } = await e.embed([
      'refund for lessons',
      'refund for lessons',
      'completely different words here',
    ]);
    expect(vectors[0]).toEqual(vectors[1]);
    expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 6);
    const dot = (a: readonly number[], b: readonly number[]): number =>
      a.reduce((s, v, i) => s + v * b[i], 0);
    expect(dot(vectors[0], vectors[1])).toBeGreaterThan(
      dot(vectors[0], vectors[2]),
    );
  });
});

describe('OpenAI-compatible embedding provider (mocked transport)', () => {
  const make = (
    respond: () => Response | Promise<Response>,
  ): {
    provider: OpenAiCompatibleEmbeddingProvider;
    calls: Array<{ url: string; body: unknown; auth: string | null }>;
  } => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> =
      [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get('authorization'),
      });
      return respond();
    }) as unknown as typeof fetch;
    return {
      provider: new OpenAiCompatibleEmbeddingProvider({
        providerId: 'gemini',
        baseUrl: 'https://example.invalid/v1beta/openai/',
        model: 'gemini-embedding-001',
        apiKey: 'unit-key',
        fetch: fetcher,
      }),
      calls,
    };
  };
  const json = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): Response => new Response(JSON.stringify(body), { status, headers });

  it('posts model and input to /embeddings and returns ordered vectors with usage', async () => {
    const { provider, calls } = make(() =>
      json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 7 },
      }),
    );
    const result = await provider.embed(['a', 'b']);
    expect(calls[0]).toEqual({
      url: 'https://example.invalid/v1beta/openai/embeddings',
      body: { model: 'gemini-embedding-001', input: ['a', 'b'] },
      auth: 'Bearer unit-key',
    });
    expect(result).toEqual({
      vectors: [
        [1, 0],
        [0, 1],
      ],
      inputTokens: 7,
    });
  });

  it.each([
    [429, 'LLM_RATE_LIMITED'],
    [401, 'LLM_AUTHENTICATION'],
    [403, 'LLM_AUTHENTICATION'],
    [404, 'LLM_UNSUPPORTED_FEATURE'],
    [503, 'LLM_UNAVAILABLE'],
    [400, 'LLM_INVALID_REQUEST'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { provider } = make(() => json({}, status));
    await expect(provider.embed(['x'])).rejects.toMatchObject({ code });
  });

  it('rejects malformed bodies and unreachable hosts without leaking the key', async () => {
    for (const body of [
      {},
      { data: [{ embedding: 'x' }] },
      { data: [{ embedding: [1] }, { embedding: [1, 2] }] },
      { data: [] },
    ]) {
      const { provider } = make(() => json(body));
      await expect(provider.embed(['a', 'b'])).rejects.toBeInstanceOf(LlmError);
    }
    const down = new OpenAiCompatibleEmbeddingProvider({
      providerId: 'x',
      baseUrl: 'http://x',
      model: 'm',
      apiKey: 'secret-key-value',
      fetch: (async () => {
        throw new Error('boom secret-key-value');
      }) as unknown as typeof fetch,
    });
    const error = (await down.embed(['a']).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: 'LLM_UNAVAILABLE' });
    expect(error.message).not.toContain('secret-key-value');
  });
});

describe('metered embeddings', () => {
  const snapshot = PRICING_CATALOG.snapshot('local-free-2026-10-23');
  const make = (
    limits = {},
  ): { llm: MeteredLlm; budget: TurnBudget; entries: LlmUsageEntry[] } => {
    const budget = new TurnBudget(
      { ...TEST_LIMITS, ...limits },
      { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
    );
    const entries: LlmUsageEntry[] = [];
    const llm = new MeteredLlm(
      {
        providerId: 'x',
        modelFor: (): string => 'm',
        generateStructured: vi.fn(),
        generateWithTools: vi.fn(),
      },
      snapshot,
      budget,
      { record: async (e): Promise<void> => void entries.push(e) },
      { tenantId: 't', conversationId: 'c', turnKey: 'turn' },
    );
    return { llm, budget, entries };
  };

  it('reserves, settles and records an embed call like a model call', async () => {
    const { llm, budget, entries } = make();
    const vectors = await llm.embed(new HashingEmbeddingProvider(8), [
      'hello world',
    ]);
    expect(vectors).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      purpose: 'embed',
      model: 'hashing-test-embedder',
      usageBasis: 'reported',
    });
    expect(budget.snapshot.reservedNano).toBe(0);
    expect(budget.snapshot.calls).toBe(1);
    expect(budget.snapshot.tokensUsed).toBeGreaterThan(0);
  });

  it('is refused when the turn cannot afford another call, and counts toward the call limit', async () => {
    const { llm } = make({ maxCallsPerTurn: 1 });
    await llm.embed(new HashingEmbeddingProvider(8), ['a']);
    await expect(
      llm.embed(new HashingEmbeddingProvider(8), ['b']),
    ).rejects.toMatchObject({ reason: 'CALL_LIMIT' });
  });

  it('treats a timeout as unknown usage and a rate limit as unbilled', async () => {
    const failing = (
      code: 'LLM_TIMEOUT' | 'LLM_RATE_LIMITED',
    ): HashingEmbeddingProvider =>
      Object.assign(new HashingEmbeddingProvider(8), {
        embed: () => Promise.reject(new LlmError(code, 'x', true)),
      });
    const timeout = make();
    await expect(
      timeout.llm.embed(failing('LLM_TIMEOUT'), ['a']),
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
    expect(timeout.entries[0]).toMatchObject({
      usageBasis: 'unknown',
      purpose: 'embed',
    });
    const limited = make();
    await expect(
      limited.llm.embed(failing('LLM_RATE_LIMITED'), ['a']),
    ).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED' });
    expect(limited.entries).toHaveLength(0);
    expect(limited.budget.snapshot.reservedNano).toBe(0);
  });

  it('refuses an unpriced embedding model before any call', async () => {
    const budget = new TurnBudget(TEST_LIMITS, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    });
    const llm = new MeteredLlm(
      {
        providerId: 'x',
        modelFor: (): string => 'm',
        generateStructured: vi.fn(),
        generateWithTools: vi.fn(),
      },
      PRICING_CATALOG.snapshot('anthropic-2026-10-23'),
      budget,
      { record: async (): Promise<void> => undefined },
      { tenantId: 't', turnKey: 'turn' },
    );
    const embedder = new HashingEmbeddingProvider(8);
    const spy = vi.spyOn(embedder, 'embed');
    await expect(llm.embed(embedder, ['a'])).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
