import { readFileSync } from 'node:fs';
import type { LlmProvider, LlmTier } from '../../core/llm/llm-provider.js';
import type { PricingSnapshot } from '../../core/llm/pricing.js';
import { pricingFor } from '../../core/llm/pricing.js';
import {
  OpenAiCompatibleLlmProvider,
  type CapabilityView,
} from '../openai-compatible/openai-compatible-provider.js';
import { capabilityFor, presetFor } from '../provider-presets.js';
import {
  ClientRateLimiter,
  RateLimitedLlmProvider,
} from '../rate-limited-provider.js';
import {
  DEFAULT_ROUTING_POLICY,
  RoutingPolicySchema,
  type RoutingPolicy,
} from './routing-policy.js';
import {
  RoutingLlmProvider,
  type RoutedCandidate,
} from './routing-provider.js';

export class RoutingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingConfigError';
  }
}

export function loadRoutingPolicy(file: string | undefined): RoutingPolicy {
  if (!file) return DEFAULT_ROUTING_POLICY;
  return RoutingPolicySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export interface RoutedBuild {
  readonly provider: RoutingLlmProvider;
  readonly policy: RoutingPolicy;
  /** Candidates dropped at boot, by reason (no secrets). */
  readonly skipped: ReadonlyArray<{ candidate: string; reason: string }>;
}

/**
 * Builds the routed provider. A candidate is skipped (and reported) when its
 * key variable is unset, its model is unpriced, or the router is trusted but
 * the candidate's provider is not in `trustedProviders`. Boot fails if a tier
 * ends up with no candidate. Keys are read only from the variable NAMED by
 * each preset; values are passed to the adapter and never logged.
 */
export function buildRoutedProvider(options: {
  readonly policy: RoutingPolicy;
  readonly snapshot: PricingSnapshot;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly trustedProviders: readonly string[];
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  /** LLM_MAX_INPUT_BYTES: must stay under every candidate's long-prompt tier. */
  readonly maxInputBytes?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly onFailover?: ConstructorParameters<typeof RoutingLlmProvider>[4];
}): RoutedBuild {
  const skipped: Array<{ candidate: string; reason: string }> = [];
  const routerTrusted = options.trustedProviders.includes('routed');
  const tiers: Record<LlmTier, RoutedCandidate[]> = { FAST: [], STRONG: [] };
  const cache = new Map<string, RoutedCandidate>();
  for (const tier of ['FAST', 'STRONG'] as const) {
    for (const ref of options.policy.tiers[tier]) {
      const label = `${ref.provider}/${ref.model}`;
      const preset = presetFor(ref.provider);
      const apiKey = options.env[preset.apiKeyEnvVar] || undefined;
      if (preset.apiKeyRequired && !apiKey) {
        skipped.push({
          candidate: label,
          reason: `${preset.apiKeyEnvVar} not set`,
        });
        continue;
      }
      try {
        pricingFor(options.snapshot, ref.model);
      } catch {
        skipped.push({ candidate: label, reason: 'model not priced' });
        continue;
      }
      const threshold = pricingFor(options.snapshot, ref.model).longContext
        ?.threshold;
      if (
        threshold !== undefined &&
        options.maxInputBytes !== undefined &&
        options.maxInputBytes + 400 > threshold
      ) {
        throw new RoutingConfigError(
          `LLM_MAX_INPUT_BYTES must stay under the ${threshold}-token long-prompt tier of ${label}`,
        );
      }
      if (routerTrusted && !options.trustedProviders.includes(ref.provider)) {
        skipped.push({ candidate: label, reason: 'provider not trusted' });
        continue;
      }
      let candidate = cache.get(label);
      if (!candidate) {
        const base = new OpenAiCompatibleLlmProvider({
          providerId: ref.provider,
          baseUrl: preset.baseUrl,
          apiKey,
          // Both tiers map to this one model; the router picks per request.
          models: { FAST: ref.model, STRONG: ref.model },
          structuredOutput: 'json_object',
          capabilityOf: (model): CapabilityView => capabilityFor(preset, model),
          maxTokensParam: preset.maxTokensParam,
          requestTimeoutMs: options.requestTimeoutMs,
          // Failover is the retry strategy across candidates: keep per
          // candidate retries to one so a failing provider is left quickly.
          maxRetries: Math.min(options.maxRetries, 1),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        const limits = preset.limits;
        const limited =
          limits.status === 'documented' &&
          (limits.requestsPerMinute ||
            limits.tokensPerMinute ||
            limits.requestsPerDay);
        const provider: LlmProvider = limited
          ? new RateLimitedLlmProvider(
              base,
              new ClientRateLimiter({
                requestsPerMinute: limits.requestsPerMinute,
                tokensPerMinute: limits.tokensPerMinute,
                requestsPerDay: limits.requestsPerDay,
                maxWaitMs: 2_000,
              }),
            )
          : base;
        candidate = {
          providerId: ref.provider,
          model: ref.model,
          provider,
          capability: capabilityFor(preset, ref.model),
        };
        cache.set(label, candidate);
      }
      tiers[tier].push(candidate);
    }
    if (tiers[tier].length === 0) {
      throw new RoutingConfigError(
        `Routing tier ${tier} has no usable candidate: ${skipped
          .map((s) => `${s.candidate} (${s.reason})`)
          .join('; ')}`,
      );
    }
  }
  return {
    provider: new RoutingLlmProvider(
      tiers,
      options.policy,
      options.snapshot,
      options.now,
      options.onFailover,
    ),
    policy: options.policy,
    skipped,
  };
}
