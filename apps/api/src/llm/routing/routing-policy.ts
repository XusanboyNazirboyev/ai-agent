import { z } from 'zod';

/**
 * Routing policy: configuration, not code. Versioned; the default below can
 * be replaced by a JSON file (LLM_ROUTING_POLICY_FILE) and later by a
 * per-tenant override. Providers are named by preset id
 * (src/llm/provider-presets.ts); keys come from the env vars those presets
 * name. FAST and STRONG are the tiers the agent core already uses
 * (extraction vs reply drafting).
 */

const CandidateRefSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9-]+$/u),
    model: z.string().min(1).max(100),
  })
  .strict();

export const RoutingPolicySchema = z
  .object({
    version: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,63}$/u),
    /** Ordered failover lists. The first healthy, capable candidate wins. */
    tiers: z
      .object({
        FAST: z.array(CandidateRefSchema).min(1).max(6),
        STRONG: z.array(CandidateRefSchema).min(1).max(6),
      })
      .strict(),
    breaker: z
      .object({
        /** Cooldown after a rate limit on one (provider, model) pair. */
        rateLimitCooldownMs: z.number().int().min(1_000).max(3_600_000),
        /** Cooldown after quota exhaustion or auth failure (whole provider). */
        providerCooldownMs: z.number().int().min(1_000).max(86_400_000),
        /** Cooldown after consecutive transient failures. */
        transientCooldownMs: z.number().int().min(1_000).max(3_600_000),
        transientFailures: z.number().int().min(1).max(20),
      })
      .strict(),
  })
  .strict();

export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;
export type CandidateRef = z.infer<typeof CandidateRefSchema>;

/**
 * Default: free providers whose tool use and constrained output are
 * documented (Groq gpt-oss/qwen strict json_schema; Gemini tools). This is a
 * starting point for testing on fake data, NOT a production recommendation;
 * every provider here is untrusted by default.
 */
/**
 * Owner decision 2026-11-09: the paid Gemini answers first; when it fails
 * (outage, rate limit, quota, timeout) the free Groq, then Mistral, then
 * OpenRouter answer instead. Price it with `routing-gemini-paid-2026-11-09`.
 * Selected with `LLM_ROUTING_POLICY_FILE=builtin:gemini-primary`.
 */
export const GEMINI_PRIMARY_ROUTING_POLICY: RoutingPolicy =
  RoutingPolicySchema.parse({
    version: 'gemini-primary-2026-11-09',
    tiers: {
      FAST: [
        { provider: 'gemini', model: 'gemini-3.8-flash' },
        { provider: 'groq', model: 'openai/gpt-oss-20b' },
        { provider: 'mistral', model: 'mistral-large-4' },
        {
          provider: 'openrouter',
          model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        },
        { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
      ],
      STRONG: [
        { provider: 'gemini', model: 'gemini-3.8-flash' },
        { provider: 'groq', model: 'openai/gpt-oss-120b' },
        { provider: 'mistral', model: 'mistral-large-4' },
        {
          provider: 'openrouter',
          model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        },
        { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
      ],
    },
    breaker: {
      rateLimitCooldownMs: 60_000,
      providerCooldownMs: 900_000,
      transientCooldownMs: 30_000,
      transientFailures: 3,
    },
  });

/**
 * Latency experiment 2026-11-10 (docs/audit/2026-11-10-latency-experiments.md):
 * extraction (FAST) goes to Groq `openai/gpt-oss-20b` first and to the paid
 * Gemini when Groq fails (rate limit, outage); replies (STRONG) are exactly
 * `gemini-primary`. Same candidates as `gemini-primary`, so the same pricing
 * snapshot (`routing-gemini-paid-2026-11-09`) and reservation model apply.
 * Selected with `LLM_ROUTING_POLICY_FILE=builtin:gemini-primary-fast-groq`.
 */
export const GEMINI_PRIMARY_FAST_GROQ_ROUTING_POLICY: RoutingPolicy =
  RoutingPolicySchema.parse({
    version: 'gemini-primary-fast-groq-2026-11-10',
    tiers: {
      FAST: [
        { provider: 'groq', model: 'openai/gpt-oss-20b' },
        { provider: 'gemini', model: 'gemini-3.8-flash' },
        { provider: 'mistral', model: 'mistral-large-4' },
        {
          provider: 'openrouter',
          model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        },
        { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
      ],
      STRONG: GEMINI_PRIMARY_ROUTING_POLICY.tiers.STRONG,
    },
    breaker: GEMINI_PRIMARY_ROUTING_POLICY.breaker,
  });

/** Policies selectable by name (`builtin:<name>`) instead of a file. */
export const BUILTIN_ROUTING_POLICIES: Readonly<Record<string, RoutingPolicy>> =
  {
    'gemini-primary': GEMINI_PRIMARY_ROUTING_POLICY,
    'gemini-primary-fast-groq': GEMINI_PRIMARY_FAST_GROQ_ROUTING_POLICY,
  };

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = RoutingPolicySchema.parse({
  version: 'routing-2026-10-23',
  tiers: {
    FAST: [
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
    ],
    STRONG: [
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'gemini', model: 'gemini-3.8-flash' },
    ],
  },
  breaker: {
    rateLimitCooldownMs: 60_000,
    providerCooldownMs: 900_000,
    transientCooldownMs: 30_000,
    transientFailures: 3,
  },
});
