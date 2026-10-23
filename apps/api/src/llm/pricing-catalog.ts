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
    'gemini-2.5-flash': { free: true },
    'gemini-2.5-flash-lite': { free: true },
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

export const PRICING_CATALOG = new PricingCatalog([
  ANTHROPIC_2026_10_23,
  GEMINI_FREE_2026_10_23,
  LOCAL_FREE_2026_10_23,
]);

export const DEFAULT_PRICING_VERSION = 'anthropic-2026-10-23';

/** Pricing older than this is flagged at startup for re-verification. */
export const PRICING_MAX_AGE_DAYS = 30;
