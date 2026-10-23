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
