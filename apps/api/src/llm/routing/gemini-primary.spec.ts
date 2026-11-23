import { describe, expect, it } from 'vitest';
import { pricingFor } from '../../core/llm/pricing.js';
import { PRICING_CATALOG } from '../pricing-catalog.js';
import {
  buildRoutedProvider,
  loadRoutingPolicy,
  RoutingConfigError,
} from './routing-factory.js';
import {
  GEMINI_LITE_ROUTING_POLICY,
  GROQ_FIRST_ROUTING_POLICY,
  GEMINI_PRIMARY_FAST_GROQ_ROUTING_POLICY,
  GEMINI_PRIMARY_ROUTING_POLICY,
} from './routing-policy.js';

/**
 * Owner decision 2026-11-09: the paid Gemini answers first; the free Groq,
 * Mistral and OpenRouter keys are its fallbacks for customer replies.
 */
const snapshot = PRICING_CATALOG.snapshot('routing-gemini-paid-2026-11-09');
const ALL_KEYS = {
  GEMINI_API_KEY: 'k-gemini',
  GROQ_API_KEY: 'k-groq',
  MISTRAL_API_KEY: 'k-mistral',
  OPEN_ROUTER_API_KEY: 'k-openrouter',
};
const TRUSTED = ['routed', 'gemini', 'groq', 'mistral', 'openrouter'];

describe('gemini-primary routing policy', () => {
  it('is loadable by name, so no policy file has to be deployed', () => {
    expect(loadRoutingPolicy('builtin:gemini-primary')).toBe(
      GEMINI_PRIMARY_ROUTING_POLICY,
    );
    expect(() => loadRoutingPolicy('builtin:nope')).toThrow(RoutingConfigError);
  });

  it('puts the paid Gemini first in both tiers, then the free fallbacks', () => {
    for (const tier of ['FAST', 'STRONG'] as const) {
      const order = GEMINI_PRIMARY_ROUTING_POLICY.tiers[tier].map(
        (c) => c.provider,
      );
      expect(order).toEqual([
        'gemini',
        'groq',
        'mistral',
        'openrouter',
        'openrouter',
      ]);
      expect(GEMINI_PRIMARY_ROUTING_POLICY.tiers[tier][0]!.model).toBe(
        'gemini-3.8-flash',
      );
    }
  });

  it('prices every candidate, Gemini at the paid rate, so none is dropped', () => {
    const built = buildRoutedProvider({
      policy: GEMINI_PRIMARY_ROUTING_POLICY,
      snapshot,
      env: ALL_KEYS,
      trustedProviders: TRUSTED,
      requestTimeoutMs: 500,
      maxRetries: 0,
    });
    expect(built.skipped).toEqual([]);
    expect(pricingFor(snapshot, 'gemini-3.8-flash')).not.toMatchObject({
      free: true,
    });
    expect(JSON.stringify(built.skipped)).not.toContain('k-');
  });

  it('drops a fallback that is not trusted, and one whose key is missing', () => {
    const built = buildRoutedProvider({
      policy: GEMINI_PRIMARY_ROUTING_POLICY,
      snapshot,
      env: { GEMINI_API_KEY: 'k', GROQ_API_KEY: 'k' },
      trustedProviders: ['routed', 'gemini', 'mistral'],
      requestTimeoutMs: 500,
      maxRetries: 0,
    });
    const reasons = built.skipped.map((s) => s.reason);
    expect(reasons).toContain('provider not trusted');
    expect(reasons).toContain('MISTRAL_API_KEY not set');
  });
});

describe('reasoning effort in routed mode (staging runs Gemini with LLM_REASONING_EFFORT)', () => {
  const body = {
    id: 'x',
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  };

  async function sent(
    broken: string[],
  ): Promise<Array<{ host: string; effort: unknown }>> {
    const seen: Array<{ host: string; effort: unknown }> = [];
    const fetchFake = ((url: string | URL | Request, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const parsed = JSON.parse(String(init?.body)) as {
        reasoning_effort?: unknown;
      };
      seen.push({ host, effort: parsed.reasoning_effort });
      return Promise.resolve(
        broken.includes(host)
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      );
    }) as typeof fetch;
    const built = buildRoutedProvider({
      policy: GEMINI_PRIMARY_ROUTING_POLICY,
      snapshot,
      env: ALL_KEYS,
      trustedProviders: TRUSTED,
      requestTimeoutMs: 500,
      maxRetries: 0,
      reasoningEffortByProvider: { gemini: 'low', groq: 'low' },
      fetch: fetchFake,
    });
    await built.provider.generateWithTools({
      tier: 'FAST',
      purpose: 'respond',
      system: 's',
      messages: [{ role: 'user', text: 'salom' }],
      tools: [],
      maxOutputTokens: 50,
    });
    return seen;
  }

  it('sends the configured effort to Gemini and Groq, and none to the others', async () => {
    const seen = await sent([
      'generativelanguage.googleapis.com',
      'api.groq.com',
      'api.mistral.ai',
    ]);
    expect(seen.map((s) => s.host)).toEqual([
      'generativelanguage.googleapis.com',
      'api.groq.com',
      'api.mistral.ai',
      'openrouter.ai',
    ]);
    expect(seen.map((s) => s.effort)).toEqual([
      'low',
      'low',
      undefined,
      undefined,
    ]);
  });
});

describe('gemini-primary-fast-groq routing policy (latency experiment)', () => {
  it('is loadable by name and leaves gemini-primary unchanged', () => {
    expect(loadRoutingPolicy('builtin:gemini-primary-fast-groq')).toBe(
      GEMINI_PRIMARY_FAST_GROQ_ROUTING_POLICY,
    );
    expect(GEMINI_PRIMARY_ROUTING_POLICY.tiers.FAST[0]!.provider).toBe(
      'gemini',
    );
  });

  it('extracts with Groq first, then Gemini; replies exactly as gemini-primary', () => {
    const fast = GEMINI_PRIMARY_FAST_GROQ_ROUTING_POLICY.tiers.FAST;
    expect(fast.slice(0, 2)).toEqual([
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
      { provider: 'gemini', model: 'gemini-3.8-flash' },
    ]);
    expect(GEMINI_PRIMARY_FAST_GROQ_ROUTING_POLICY.tiers.STRONG).toEqual(
      GEMINI_PRIMARY_ROUTING_POLICY.tiers.STRONG,
    );
    const label = (c: { provider: string; model: string }): string =>
      `${c.provider}/${c.model}`;
    expect(new Set(fast.map(label))).toEqual(
      new Set(GEMINI_PRIMARY_ROUTING_POLICY.tiers.FAST.map(label)),
    );
  });

  it('builds with the same pricing snapshot, every candidate priced', () => {
    const built = buildRoutedProvider({
      policy: GEMINI_PRIMARY_FAST_GROQ_ROUTING_POLICY,
      snapshot,
      env: ALL_KEYS,
      trustedProviders: TRUSTED,
      requestTimeoutMs: 500,
      maxRetries: 0,
    });
    expect(built.skipped).toEqual([]);
    // The reservation model (worst case) is the same as gemini-primary's.
    const base = buildRoutedProvider({
      policy: GEMINI_PRIMARY_ROUTING_POLICY,
      snapshot,
      env: ALL_KEYS,
      trustedProviders: TRUSTED,
      requestTimeoutMs: 500,
      maxRetries: 0,
    });
    expect(built.provider.modelFor('FAST')).toBe(
      base.provider.modelFor('FAST'),
    );
  });
});

describe('gemini-lite routing policy (cost experiment 2026-11-21)', () => {
  const lite = PRICING_CATALOG.snapshot('routing-gemini-lite-2026-11-21');

  it('is loadable by name: Flash-Lite first, then the free fallbacks', () => {
    expect(loadRoutingPolicy('builtin:gemini-lite')).toBe(
      GEMINI_LITE_ROUTING_POLICY,
    );
    for (const tier of ['FAST', 'STRONG'] as const) {
      const candidates = GEMINI_LITE_ROUTING_POLICY.tiers[tier];
      expect(candidates[0]).toEqual({
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
      });
      expect(candidates.slice(1)).toEqual(
        GEMINI_PRIMARY_ROUTING_POLICY.tiers[tier]
          .slice(1)
          .filter((c) => c.provider !== 'mistral'),
      );
    }
  });

  it('builds with every candidate priced at the published Flash-Lite rate', () => {
    const built = buildRoutedProvider({
      policy: GEMINI_LITE_ROUTING_POLICY,
      snapshot: lite,
      env: ALL_KEYS,
      trustedProviders: TRUSTED,
      requestTimeoutMs: 500,
      maxRetries: 0,
    });
    expect(built.skipped).toEqual([]);
    // Per 1K tokens in nano-USD: $0.30, $2.50 and $0.03 per 1M tokens.
    expect(lite.models['gemini-3.5-flash-lite']).toMatchObject({
      free: false,
      standard: { input: 300, output: 2500, cacheRead: 30 },
    });
    expect(lite.source).toBe('https://ai.google.dev/gemini-api/docs/pricing');
    expect(lite.validUntil).toBeUndefined();
  });
});

describe('groq-first routing policy (owner 2026-11-23)', () => {
  it('answers with free Groq first, paid Flash-Lite after it, and no OpenRouter free endpoint', () => {
    expect(loadRoutingPolicy('builtin:groq-first')).toBe(
      GROQ_FIRST_ROUTING_POLICY,
    );
    for (const tier of ['FAST', 'STRONG'] as const) {
      const providers = GROQ_FIRST_ROUTING_POLICY.tiers[tier].map(
        (c) => c.provider,
      );
      expect(providers).toEqual(['groq', 'gemini']);
    }
  });

  it('builds with every candidate priced by the Flash-Lite snapshot', () => {
    const built = buildRoutedProvider({
      policy: GROQ_FIRST_ROUTING_POLICY,
      snapshot: PRICING_CATALOG.snapshot('routing-gemini-lite-2026-11-21'),
      env: ALL_KEYS,
      trustedProviders: TRUSTED,
      requestTimeoutMs: 500,
      maxRetries: 0,
    });
    expect(built.skipped).toEqual([]);
  });
});
