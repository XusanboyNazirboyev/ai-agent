import type { LlmUsage } from './llm-provider.js';

/**
 * Versioned pricing snapshot. Amounts are integer nano-USD per token
 * (1 nUSD = 1e-9 USD; $1 per million tokens = 1,000 nUSD per token), so cost
 * arithmetic is exact integer math. Prices are never fetched per request.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing, checked
 * 2026-10-23 (first-party Claude API, global routing; `inference_geo: "us"`
 * would add 1.1x and is not used). Update by adding a new version, never by
 * editing an existing one, so historical usage stays reproducible.
 */

export interface TokenRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

export interface ModelPricing {
  readonly standard: TokenRates;
  /** Higher card applied when a prompt exceeds `threshold` input tokens. */
  readonly longContext?: {
    readonly threshold: number;
    readonly rates: TokenRates;
  };
}

export interface PricingSnapshot {
  readonly version: string;
  readonly checkedAt: string;
  readonly source: string;
  readonly models: Readonly<Record<string, ModelPricing>>;
}

const perMTok = (usd: number): number => Math.round(usd * 1_000);

const rates = (input: number, output: number): TokenRates => ({
  input: perMTok(input),
  output: perMTok(output),
  cacheRead: perMTok(input * 0.1),
  cacheWrite5m: perMTok(input * 1.25),
  cacheWrite1h: perMTok(input * 2),
});

export const PRICING_SNAPSHOTS: Readonly<Record<string, PricingSnapshot>> = {
  'anthropic-2026-10-23': {
    version: 'anthropic-2026-10-23',
    checkedAt: '2026-10-23',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    models: {
      'claude-haiku-5-5': {
        standard: rates(0.1, 0.5),
        longContext: { threshold: 100_000, rates: rates(0.5, 2.5) },
      },
      // Sonnet 5.5 and Opus 5.5 cache reads are 0.05x input, not 0.1x.
      'claude-sonnet-5-5': {
        standard: { ...rates(2, 10), cacheRead: perMTok(0.1) },
      },
      'claude-opus-5-5': {
        standard: { ...rates(4, 20), cacheRead: perMTok(0.2) },
      },
      // Deterministic mock provider: priced like Haiku so budgets are testable.
      'mock-deterministic': { standard: rates(0.1, 0.5) },
    },
  },
};

export const DEFAULT_PRICING_VERSION = 'anthropic-2026-10-23';

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

export function pricingFor(version: string, model: string): ModelPricing {
  const snapshot = PRICING_SNAPSHOTS[version];
  if (!snapshot) throw new PricingError(`Unknown pricing version ${version}`);
  const pricing = snapshot.models[model];
  if (!pricing) {
    // An unpriced model must not run: its cost could not be bounded.
    throw new PricingError(`No pricing for model ${model} in ${version}`);
  }
  return pricing;
}

function ratesForPrompt(
  pricing: ModelPricing,
  promptTokens: number,
): TokenRates {
  return pricing.longContext && promptTokens > pricing.longContext.threshold
    ? pricing.longContext.rates
    : pricing.standard;
}

/** Exact cost of reported usage, in integer nano-USD. */
export function costOfUsage(pricing: ModelPricing, usage: LlmUsage): number {
  const prompt =
    usage.inputTokens +
    usage.cacheReadTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens;
  const r = ratesForPrompt(pricing, prompt);
  const cost =
    usage.inputTokens * r.input +
    usage.outputTokens * r.output +
    usage.cacheReadTokens * r.cacheRead +
    usage.cacheWrite5mTokens * r.cacheWrite5m +
    usage.cacheWrite1hTokens * r.cacheWrite1h;
  if (!Number.isSafeInteger(cost)) throw new PricingError('Cost overflow');
  return cost;
}

/**
 * Upper-bound cost reserved before a call: every input token at the most
 * expensive input rate and the full output ceiling.
 */
export function worstCaseCost(
  pricing: ModelPricing,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number {
  const r = ratesForPrompt(pricing, estimatedInputTokens);
  return (
    estimatedInputTokens * Math.max(r.input, r.cacheWrite5m) +
    maxOutputTokens * r.output
  );
}

/** Parses a USD decimal string ("0.02") into integer nano-USD exactly. */
export function usdToNano(usd: string): number {
  const match = /^(\d{1,6})(?:\.(\d{1,9}))?$/.exec(usd.trim());
  if (!match) throw new PricingError(`Invalid USD amount: ${usd}`);
  const fraction = (match[2] ?? '').padEnd(9, '0');
  return Number(match[1]) * 1_000_000_000 + Number(fraction);
}

export function nanoToUsd(nano: number): string {
  const whole = Math.trunc(nano / 1_000_000_000);
  const fraction = String(nano % 1_000_000_000).padStart(9, '0');
  return `${whole}.${fraction}`.replace(/0+$/, '').replace(/\.$/, '.0');
}
