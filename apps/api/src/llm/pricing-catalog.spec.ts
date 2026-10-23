import { describe, expect, it } from 'vitest';
import {
  costOfUsage,
  pricingAgeDays,
  pricingFor,
  usdToNano,
} from '../core/llm/pricing.js';
import {
  DEFAULT_PRICING_VERSION,
  PRICING_CATALOG,
  PRICING_MAX_AGE_DAYS,
} from './pricing-catalog.js';

const snapshot = PRICING_CATALOG.snapshot(DEFAULT_PRICING_VERSION);

describe('configured Claude pricing (anthropic-2026-10-23)', () => {
  it('records provenance: source URL and asOf date', () => {
    expect(snapshot).toMatchObject({
      provider: 'anthropic',
      asOf: '2026-10-23',
      source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    });
    expect(PRICING_MAX_AGE_DAYS).toBe(30);
    expect(pricingAgeDays(snapshot, new Date('2026-10-23T12:00:00Z'))).toBe(0);
  });

  it('matches the published Claude Haiku 5.5 tiers exactly', () => {
    const haiku = pricingFor(snapshot, 'claude-haiku-5-5');
    expect(haiku.standard).toEqual({
      input: 100,
      output: 500,
      cacheRead: 10,
      cacheWrite5m: 125,
      cacheWrite1h: 200,
    });
    expect(haiku.longContext).toEqual({
      threshold: 100_000,
      rates: {
        input: 500,
        output: 2_500,
        cacheRead: 50,
        cacheWrite5m: 625,
        cacheWrite1h: 1_000,
      },
    });
    expect(haiku.toolUseSystemPromptTokens).toBe(286);
    // 10,000 input + 1,000 output on the standard tier = $0.0015
    expect(
      costOfUsage(haiku, {
        inputTokens: 10_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      }),
    ).toBe(usdToNano('0.0015'));
  });

  it('records the 0.05x cache-read rate of Sonnet 5.5 and Opus 5.5', () => {
    expect(pricingFor(snapshot, 'claude-sonnet-5-5').standard).toMatchObject({
      input: 2_000,
      output: 10_000,
      cacheRead: 100,
    });
    expect(pricingFor(snapshot, 'claude-opus-5-5').standard).toMatchObject({
      input: 4_000,
      output: 20_000,
      cacheRead: 200,
    });
    expect(pricingFor(snapshot, 'claude-sonnet-5-5').longContext).toBe(
      undefined,
    );
  });
});
