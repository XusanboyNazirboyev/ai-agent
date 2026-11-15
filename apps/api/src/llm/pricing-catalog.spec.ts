import { pricingDaysLeft } from '../core/llm/pricing.js';
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

describe('price lists with an end date', () => {
  const at = (iso: string): Date => new Date(`${iso}T12:00:00Z`);
  it('the 2026 Gemini prices end on December 31 and say so', () => {
    for (const version of [
      'gemini-paid-2026-10-29',
      'routing-gemini-paid-2026-11-09',
    ]) {
      const snapshot = PRICING_CATALOG.snapshot(version);
      expect(snapshot.validUntil, version).toBe('2026-12-31');
      expect(pricingDaysLeft(snapshot, at('2026-12-17'))).toBe(14);
      expect(pricingDaysLeft(snapshot, at('2026-12-31'))).toBe(0);
      expect(pricingDaysLeft(snapshot, at('2027-01-01'))).toBe(-1);
    }
  });

  it('the announced 2027 prices are ready and twice the 2026 ones, with no end date', () => {
    const now = PRICING_CATALOG.snapshot('gemini-paid-2026-10-29').models[
      'gemini-3.8-flash'
    ]!;
    for (const version of [
      'gemini-paid-2027-01-01',
      'routing-gemini-paid-2027-01-01',
    ]) {
      const next = PRICING_CATALOG.snapshot(version);
      expect(next.validUntil, version).toBeUndefined();
      expect(pricingDaysLeft(next, at('2027-06-01'))).toBeNull();
      const model = next.models['gemini-3.8-flash']!;
      expect(model.free).toBe(false);
      for (const rate of [
        'input',
        'output',
        'cacheRead',
        'cacheWrite5m',
        'cacheWrite1h',
      ] as const)
        expect(model.standard[rate], `${version} ${rate}`).toBeCloseTo(
          now.standard[rate] * 2,
          12,
        );
    }
    // The free fallbacks of the routing table are unchanged.
    expect(
      Object.keys(
        PRICING_CATALOG.snapshot('routing-gemini-paid-2027-01-01').models,
      ).sort(),
    ).toEqual(
      Object.keys(
        PRICING_CATALOG.snapshot('routing-gemini-paid-2026-11-09').models,
      ).sort(),
    );
  });
});
