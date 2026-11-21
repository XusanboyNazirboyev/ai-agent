import { PricingCatalog, type PricingConfig } from '../core/llm/pricing.js';

/**
 * Model price configuration (USD per million tokens, as published).
 *
 * anthropic-2026-10-23: read from
 * https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-23
 * (model pricing table, prompt-caching multipliers, "Long context pricing"
 * and the tool-use system prompt table). First-party Claude API, global
 * routing; `inference_geo: "us"` (1.1x) is not used. Model IDs checked on
 * https://platform.claude.com/docs/en/models/overview the same day.
 *
 * Add a new entry for a price change; never edit a published version.
 */
const ANTHROPIC_2026_10_23: PricingConfig = {
  version: 'anthropic-2026-10-23',
  provider: 'anthropic',
  asOf: '2026-10-23',
  sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  models: {
    // "for prompts up to 100,000 tokens" / "for prompts over 100,000 tokens";
    // prompt length counts all input tokens, including cache reads/writes.
    'claude-haiku-5-5': {
      inputPerMTok: '0.10',
      cacheWrite5mPerMTok: '0.125',
      cacheWrite1hPerMTok: '0.20',
      cacheReadPerMTok: '0.01',
      outputPerMTok: '0.50',
      toolUseSystemPromptTokens: 286,
      longPrompt: {
        thresholdTokens: 100_000,
        inputPerMTok: '0.50',
        cacheWrite5mPerMTok: '0.625',
        cacheWrite1hPerMTok: '1',
        cacheReadPerMTok: '0.05',
        outputPerMTok: '2.50',
      },
    },
    // Full context window at standard pricing; cache hits are 0.05x input.
    'claude-sonnet-5-5': {
      inputPerMTok: '2',
      cacheWrite5mPerMTok: '2.50',
      cacheWrite1hPerMTok: '4',
      cacheReadPerMTok: '0.10',
      outputPerMTok: '10',
      toolUseSystemPromptTokens: 286,
    },
    'claude-opus-5-5': {
      inputPerMTok: '4',
      cacheWrite5mPerMTok: '5',
      cacheWrite1hPerMTok: '8',
      cacheReadPerMTok: '0.20',
      outputPerMTok: '20',
      toolUseSystemPromptTokens: 286,
    },
    // Offline mock provider (never billed): priced like Haiku's standard
    // tier, with the same threshold, so budget limits are exercised in tests.
    'mock-deterministic': {
      inputPerMTok: '0.10',
      cacheWrite5mPerMTok: '0.125',
      cacheWrite1hPerMTok: '0.20',
      cacheReadPerMTok: '0.01',
      outputPerMTok: '0.50',
      longPrompt: {
        thresholdTokens: 100_000,
        inputPerMTok: '0.50',
        cacheWrite5mPerMTok: '0.625',
        cacheWrite1hPerMTok: '1',
        cacheReadPerMTok: '0.05',
        outputPerMTok: '2.50',
      },
    },
  },
};

/**
 * Gemini API Free Tier through its OpenAI-compatible endpoint. Read from
 * https://ai.google.dev/gemini-api/docs/pricing on 2026-10-23: each listed
 * model shows Free Tier input and output "Free of charge", and the Free
 * Tier row "Used to improve our products" is "Yes" (Paid Tier: "No"). Use
 * fake or seed data only. Free-tier RPM/TPM/RPD limits are per account in
 * AI Studio and are not published on the docs page, so they are configured
 * (LLM_RATE_LIMIT_*), not encoded here. Cost is 0; token caps still apply.
 */
const GEMINI_FREE_2026_10_23: PricingConfig = {
  version: 'gemini-free-2026-10-23',
  provider: 'google',
  asOf: '2026-10-23',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  models: {
    'gemini-3.8-flash': { free: true },
    'gemini-3.6-flash': { free: true },
    'gemini-3.5-flash-lite': { free: true },
    'gemini-3.1-flash-lite': { free: true },
    'gemini-3-flash-preview': { free: true },
    'gemini-2.5-pro': { free: true },
  },
};

/**
 * Gemini API Paid Tier, Standard (not Batch, Flex or Priority), through the
 * OpenAI-compatible endpoint. Read from
 * https://ai.google.dev/gemini-api/docs/pricing on 2026-10-29, model
 * `gemini-3.8-flash` only: input $0.75, output $3.75 ("including thinking
 * tokens"), context caching $0.075 per 1M tokens, each "through December
 * 31, 2026". The page announces double prices from January 1, 2027 (input
 * $1.50, output $7.50, caching $0.15): this version must not be used after
 * 2026-12-31; add a new version then. No prompt-length tiers are stated.
 * Storage ($0.50 per 1M tokens per hour) applies to explicit caches, which
 * AgentCore does not create, so it is not modelled.
 *
 * Gemini publishes no cache-write price. The schema requires one, and the
 * OpenAI-compatible adapter never reports cache-write tokens (always 0,
 * openai-compatible-provider.ts `usageOf`), so both cache-write fields are
 * set to the input price as a placeholder that is never billed.
 */
const GEMINI_PAID_2026_10_29: PricingConfig = {
  version: 'gemini-paid-2026-10-29',
  provider: 'google',
  asOf: '2026-10-29',
  validUntil: '2026-12-31',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  models: {
    'gemini-3.8-flash': {
      inputPerMTok: '0.75',
      outputPerMTok: '3.75',
      cacheReadPerMTok: '0.075',
      cacheWrite5mPerMTok: '0.75',
      cacheWrite1hPerMTok: '0.75',
    },
  },
};

/**
 * Local inference (e.g. Ollama, https://docs.ollama.com/api/openai-compatibility,
 * checked 2026-10-23): no per-token price, any model name. Cost is 0; the
 * token caps bound usage.
 */
const LOCAL_FREE_2026_10_23: PricingConfig = {
  version: 'local-free-2026-10-23',
  provider: 'local',
  asOf: '2026-10-23',
  sourceUrl: 'https://docs.ollama.com/api/openai-compatibility',
  models: { '*': { free: true } },
};

/**
 * Free-tier models usable by the routed provider. Explicit ids only (no
 * wildcard) so a paid or unknown model can never be priced as free.
 * Groq: ids from console.groq.com/docs/tool-use and /structured-outputs;
 * the page does not state per-token prices, so these are listed only as
 * models run on the free/developer plan (cost 0 to the account). Gemini:
 * Free Tier ids from ai.google.dev/gemini-api/docs/pricing. Add LLM7,
 * OpenRouter (":free" ids) or Mistral models here once their ids/prices are
 * verified; until then they cannot be routed (unpriced models cannot run).
 */
const ROUTING_FREE_2026_10_23: PricingConfig = {
  version: 'routing-free-2026-10-23',
  provider: 'multi',
  asOf: '2026-10-23',
  sourceUrl: 'https://console.groq.com/docs/tool-use',
  models: {
    'llama-3.1-8b-instant': { free: true },
    'llama-3.3-70b-versatile': { free: true },
    'openai/gpt-oss-20b': { free: true },
    'openai/gpt-oss-120b': { free: true },
    'qwen/qwen3.8-27b': { free: true },
    'gemini-3.8-flash': { free: true },
    'gemini-3.6-flash': { free: true },
    'gemini-3.5-flash-lite': { free: true },
    'gemini-3.1-flash-lite': { free: true },
    'gemini-2.5-flash': { free: true },
    'gemini-2.5-flash-lite': { free: true },
    // Embedding model listed on the Gemini pricing page with free input on
    // the Free Tier (checked 2026-10-24; free-tier content is used to improve
    // Google's products, so only fictional text may be sent).
    'gemini-embedding-2': { free: true },
  },
};

/**
 * Owner decision 2026-11-09: the paid Gemini answers customers first; the
 * free Groq, Mistral and OpenRouter keys are its fallbacks (routing policy
 * `builtin:gemini-primary`). Every entry is verified, nothing is guessed:
 * - `gemini-3.8-flash`: Paid Tier prices as in `gemini-paid-2026-10-29`
 *   (https://ai.google.dev/gemini-api/docs/pricing, read 2026-10-29, valid
 *   through 2026-12-31).
 * - Groq `openai/gpt-oss-20b` / `-120b`: run on the free plan, cost 0 to the
 *   account, as in `routing-free-2026-10-23`. If the key is moved to a paid
 *   Groq plan, add its prices here first.
 * - Mistral `mistral-large-4`: https://mistral.ai/pricing read 2026-11-09
 *   says "Mistral Large costs $0.5 /M tokens in and $1.5 /M tokens out"
 *   (the page lists no Small or Medium price); `mistral-large-4` is the only
 *   Large id the key's /v1/models returned on 2026-11-09, with function
 *   calling. No cache price is published: cached tokens are billed at the
 *   input price (an upper bound).
 * - OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` and
 *   `google/gemma-4-31b-it:free`: /api/v1/models on 2026-11-09 gave prompt
 *   and completion price "0" and `tools` support (free models are often
 *   rate limited upstream, hence two).
 * LLM7 is not listed: its site states no per-token prices, so it cannot be
 * priced and is never routed.
 */
const ROUTING_GEMINI_PAID_2026_11_09: PricingConfig = {
  version: 'routing-gemini-paid-2026-11-09',
  provider: 'multi',
  asOf: '2026-11-09',
  validUntil: '2026-12-31',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  models: {
    'gemini-3.8-flash': GEMINI_PAID_2026_10_29.models['gemini-3.8-flash']!,
    'openai/gpt-oss-20b': { free: true },
    'openai/gpt-oss-120b': { free: true },
    'mistral-large-4': {
      inputPerMTok: '0.5',
      outputPerMTok: '1.5',
      cacheReadPerMTok: '0.5',
      cacheWrite5mPerMTok: '0.5',
      cacheWrite1hPerMTok: '0.5',
    },
    'nvidia/nemotron-3-ultra-550b-a55b:free': { free: true },
    'google/gemma-4-31b-it:free': { free: true },
  },
};

/**
 * The Gemini Paid Tier prices Google announced from January 1, 2027, on the
 * same page (https://ai.google.dev/gemini-api/docs/pricing, read 2026-10-29):
 * input $1.50, output $7.50, context caching $0.15 per 1M tokens for
 * `gemini-3.8-flash`. Prepared so the switch on January 1 is one setting
 * (`LLM_PRICING_VERSION`); re-read the page before switching, since an
 * announcement can change. Using it earlier only overstates the cost.
 */
const GEMINI_PAID_2027_01_01: PricingConfig = {
  version: 'gemini-paid-2027-01-01',
  provider: 'google',
  asOf: '2026-10-29',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  models: {
    'gemini-3.8-flash': {
      inputPerMTok: '1.50',
      outputPerMTok: '7.50',
      cacheReadPerMTok: '0.15',
      cacheWrite5mPerMTok: '1.50',
      cacheWrite1hPerMTok: '1.50',
    },
  },
};

/** The 2026-11-09 routing table with the 2027 Gemini prices (see above). */
const ROUTING_GEMINI_PAID_2027_01_01: PricingConfig = {
  version: 'routing-gemini-paid-2027-01-01',
  provider: 'multi',
  asOf: '2026-10-29',
  sourceUrl: ROUTING_GEMINI_PAID_2026_11_09.sourceUrl,
  models: {
    ...ROUTING_GEMINI_PAID_2026_11_09.models,
    'gemini-3.8-flash': GEMINI_PAID_2027_01_01.models['gemini-3.8-flash']!,
  },
};

/**
 * Cost experiment 2026-11-21 (owner: plans five to six times cheaper): the
 * routing table with `gemini-3.5-flash-lite` first. Prices from
 * https://ai.google.dev/gemini-api/docs/pricing, read 2026-11-20: text input
 * $0.30, output $2.50, context caching $0.03 per 1M tokens, no announced 2027
 * change. Cache-write fields carry the input price as the never-billed
 * placeholder explained above `GEMINI_PAID_2026_10_29`. Only free fallbacks:
 * Mistral's rates neither dominate nor are dominated by Flash-Lite's, which
 * the router's worst-case reservation refuses.
 */
const ROUTING_GEMINI_LITE_2026_11_21: PricingConfig = {
  version: 'routing-gemini-lite-2026-11-21',
  provider: 'multi',
  asOf: '2026-11-20',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  models: {
    'gemini-3.5-flash-lite': {
      inputPerMTok: '0.30',
      outputPerMTok: '2.50',
      cacheReadPerMTok: '0.03',
      cacheWrite5mPerMTok: '0.30',
      cacheWrite1hPerMTok: '0.30',
    },
    'openai/gpt-oss-20b': { free: true },
    'openai/gpt-oss-120b': { free: true },
    'nvidia/nemotron-3-ultra-550b-a55b:free': { free: true },
    'google/gemma-4-31b-it:free': { free: true },
  },
};

export const PRICING_CATALOG = new PricingCatalog([
  ANTHROPIC_2026_10_23,
  GEMINI_FREE_2026_10_23,
  GEMINI_PAID_2026_10_29,
  LOCAL_FREE_2026_10_23,
  ROUTING_FREE_2026_10_23,
  ROUTING_GEMINI_PAID_2026_11_09,
  GEMINI_PAID_2027_01_01,
  ROUTING_GEMINI_PAID_2027_01_01,
  ROUTING_GEMINI_LITE_2026_11_21,
]);

export const DEFAULT_PRICING_VERSION = 'anthropic-2026-10-23';

/** A price list ending within this many days is flagged at startup. */
export const PRICING_EXPIRY_WARN_DAYS = 14;

/** Pricing older than this is flagged at startup for re-verification. */
export const PRICING_MAX_AGE_DAYS = 30;
