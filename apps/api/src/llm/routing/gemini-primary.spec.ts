import { describe, expect, it } from 'vitest';
import { pricingFor } from '../../core/llm/pricing.js';
import { PRICING_CATALOG } from '../pricing-catalog.js';
import {
  buildRoutedProvider,
  loadRoutingPolicy,
  RoutingConfigError,
} from './routing-factory.js';
import { GEMINI_PRIMARY_ROUTING_POLICY } from './routing-policy.js';

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
