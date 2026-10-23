import { z } from 'zod';
import type { LlmUsage } from './llm-provider.js';

/**
 * Versioned model pricing. Prices are configured as decimal strings in USD
 * per million tokens, exactly as the provider publishes them, and converted
 * to integer nano-USD per token (1 nUSD = 1e-9 USD; $1/MTok = 1,000 nUSD per
 * token) by string arithmetic, so no floating-point value ever enters cost
 * math. A price that is not a whole number of nano-USD per token is
 * rejected rather than rounded.
 *
 * Price data lives outside the core (`src/llm/pricing-catalog.ts`). Update
 * by adding a new version, never by editing an existing one, so historical
 * usage stays reproducible.
 */

const decimalUsd = z
  .string()
  .regex(/^\d{1,6}(?:\.\d{1,9})?$/u, 'USD per MTok as a decimal string');

const RatesConfigSchema = z
  .object({
    inputPerMTok: decimalUsd,
    outputPerMTok: decimalUsd,
    cacheReadPerMTok: decimalUsd,
    cacheWrite5mPerMTok: decimalUsd,
    cacheWrite1hPerMTok: decimalUsd,
  })
  .strict();

const ModelPricingConfigSchema = RatesConfigSchema.extend({
  /** Provider-added tool-use system prompt (tool_choice auto), in tokens. */
  toolUseSystemPromptTokens: z.number().int().min(0).max(10_000).optional(),
  /** Higher prices for prompts over `thresholdTokens` input tokens. */
  longPrompt: RatesConfigSchema.extend({
    thresholdTokens: z.number().int().min(1),
  })
    .strict()
    .optional(),
}).strict();

/**
 * A zero-cost model (free tier, local inference). Cost is 0, but the token
 * caps in the budget still bound every call. The entry keeps the same
 * provenance (`asOf`, `sourceUrl`) as priced ones.
 */
const FreeModelConfigSchema = z
  .object({
    free: z.literal(true),
    toolUseSystemPromptTokens: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

/** Matches any model id; allowed only for a free entry. */
export const ANY_MODEL = '*';

export const PricingConfigSchema = z
  .object({
    version: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,63}$/u),
    provider: z.string().min(1).max(40),
    /** Date the prices were read from `sourceUrl` (YYYY-MM-DD). */
    asOf: z.iso.date(),
    sourceUrl: z.url(),
    models: z.record(
      z.string().min(1).max(100),
      z.union([FreeModelConfigSchema, ModelPricingConfigSchema]),
    ),
  })
  .strict()
  .superRefine((config, context) => {
    const wildcard = config.models[ANY_MODEL];
    if (wildcard && !('free' in wildcard)) {
      context.addIssue({
        code: 'custom',
        path: ['models', ANY_MODEL],
        message: 'a wildcard model entry must be free',
      });
    }
  });

export type PricingConfig = z.input<typeof PricingConfigSchema>;

export interface TokenRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

export interface ModelPricing {
  /** Zero-cost entry; budgets rely on the token caps. */
  readonly free: boolean;
  readonly standard: TokenRates;
  readonly toolUseSystemPromptTokens?: number;
  /** Rates applied when a prompt exceeds `threshold` input tokens. */
  readonly longContext?: {
    readonly threshold: number;
    readonly rates: TokenRates;
  };
}

export interface PricingSnapshot {
  readonly version: string;
  readonly provider: string;
  readonly asOf: string;
  readonly source: string;
  readonly models: Readonly<Record<string, ModelPricing>>;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/** "0.125" USD/MTok -> 125 nano-USD per token, by string arithmetic. */
export function perMTokToNanoPerToken(usdPerMTok: string): number {
  // nano-USD per token = USD per MTok x 1e9 / 1e6 = USD per MTok x 1,000.
  const match = /^(\d{1,6})(?:\.(\d{1,9}))?$/u.exec(usdPerMTok);
  if (!match) throw new PricingError(`Invalid price ${usdPerMTok}`);
  const fraction = (match[2] ?? '').replace(/0+$/u, '');
  if (fraction.length > 3) {
    throw new PricingError(
      `Price ${usdPerMTok}/MTok is not a whole number of nano-USD per token`,
    );
  }
  return Number(match[1]) * 1_000 + Number(fraction.padEnd(3, '0'));
}

function toRates(config: z.infer<typeof RatesConfigSchema>): TokenRates {
  return {
    input: perMTokToNanoPerToken(config.inputPerMTok),
    output: perMTokToNanoPerToken(config.outputPerMTok),
    cacheRead: perMTokToNanoPerToken(config.cacheReadPerMTok),
    cacheWrite5m: perMTokToNanoPerToken(config.cacheWrite5mPerMTok),
    cacheWrite1h: perMTokToNanoPerToken(config.cacheWrite1hPerMTok),
  };
}

const ZERO_RATES: TokenRates = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

export function parsePricingConfig(raw: unknown): PricingSnapshot {
  const config = PricingConfigSchema.parse(raw);
  const models: Record<string, ModelPricing> = {};
  for (const [model, entry] of Object.entries(config.models)) {
    if ('free' in entry) {
      models[model] = {
        free: true,
        standard: ZERO_RATES,
        ...(entry.toolUseSystemPromptTokens !== undefined
          ? { toolUseSystemPromptTokens: entry.toolUseSystemPromptTokens }
          : {}),
      };
      continue;
    }
    models[model] = {
      free: false,
      standard: toRates(entry),
      ...(entry.toolUseSystemPromptTokens !== undefined
        ? { toolUseSystemPromptTokens: entry.toolUseSystemPromptTokens }
        : {}),
      ...(entry.longPrompt
        ? {
            longContext: {
              threshold: entry.longPrompt.thresholdTokens,
              rates: toRates(entry.longPrompt),
            },
          }
        : {}),
    };
  }
  return {
    version: config.version,
    provider: config.provider,
    asOf: config.asOf,
    source: config.sourceUrl,
    models,
  };
}

/** All configured pricing versions, validated once at load. */
export class PricingCatalog {
  private readonly snapshots = new Map<string, PricingSnapshot>();

  constructor(configs: readonly unknown[]) {
    for (const raw of configs) {
      const snapshot = parsePricingConfig(raw);
      if (this.snapshots.has(snapshot.version))
        throw new PricingError(`Duplicate pricing version ${snapshot.version}`);
      this.snapshots.set(snapshot.version, snapshot);
    }
  }

  has(version: string): boolean {
    return this.snapshots.has(version);
  }

  snapshot(version: string): PricingSnapshot {
    const snapshot = this.snapshots.get(version);
    if (!snapshot) throw new PricingError(`Unknown pricing version ${version}`);
    return snapshot;
  }
}

export function pricingFor(
  snapshot: PricingSnapshot,
  model: string,
): ModelPricing {
  const pricing = snapshot.models[model] ?? snapshot.models[ANY_MODEL];
  if (!pricing) {
    // An unpriced model must not run: its cost could not be bounded.
    throw new PricingError(
      `No pricing for model ${model} in ${snapshot.version}`,
    );
  }
  return pricing;
}

/**
 * Largest prompt (input tokens, cache included) a call may have so it stays
 * on the standard rates; `undefined` when the model has a single tier.
 */
export function maxStandardPromptTokens(
  pricing: ModelPricing,
): number | undefined {
  return pricing.longContext?.threshold;
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
  // Prompt length counts every input token, including cache reads/writes.
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
 * expensive input rate of the tier the prompt falls in, plus the full
 * output ceiling.
 */
export function worstCaseCost(
  pricing: ModelPricing,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number {
  const r = ratesForPrompt(pricing, estimatedInputTokens);
  return (
    estimatedInputTokens * Math.max(r.input, r.cacheWrite5m, r.cacheWrite1h) +
    maxOutputTokens * r.output
  );
}

/** Whole days between `asOf` and `now` (UTC). */
export function pricingAgeDays(snapshot: PricingSnapshot, now: Date): number {
  const asOf = Date.parse(`${snapshot.asOf}T00:00:00Z`);
  return Math.floor((now.getTime() - asOf) / 86_400_000);
}

/** Parses a USD decimal string ("0.02") into integer nano-USD exactly. */
export function usdToNano(usd: string): number {
  const match = /^(\d{1,6})(?:\.(\d{1,9}))?$/u.exec(usd.trim());
  if (!match) throw new PricingError(`Invalid USD amount: ${usd}`);
  const fraction = (match[2] ?? '').padEnd(9, '0');
  return Number(match[1]) * 1_000_000_000 + Number(fraction);
}

export function nanoToUsd(nano: number): string {
  const whole = Math.trunc(nano / 1_000_000_000);
  const fraction = String(nano % 1_000_000_000).padStart(9, '0');
  return `${whole}.${fraction}`.replace(/0+$/u, '').replace(/\.$/u, '.0');
}
