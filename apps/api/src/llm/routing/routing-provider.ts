import {
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmTier,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type ToolGenerationRequest,
  type ToolGenerationResult,
} from '../../core/llm/llm-provider.js';
import {
  pricingFor,
  worstCaseCost,
  type PricingSnapshot,
} from '../../core/llm/pricing.js';
import type { CapabilityView } from '../openai-compatible/openai-compatible-provider.js';
import type { RoutingPolicy } from './routing-policy.js';

/**
 * Failover router behind the unchanged LlmProvider interface (ADR 012).
 * Routing is cost/availability optimization only: guardrails, tool
 * authorization, provenance and budgets are enforced by the core and
 * MeteredLlm identically whichever candidate answers.
 *
 * - Candidates are tried in policy order, skipping any whose breaker is open
 *   or that lacks the capability the request needs (tools / structured).
 * - Failover happens only on errors that carry no billable response:
 *   rate limit, quota exhausted, unavailable/timeout, unsupported feature,
 *   authentication. Never on invalid requests or cancellation, and never on
 *   a returned (billed) result, even a malformed one.
 * - `modelFor(tier)` returns a fixed reservation model, the candidate with
 *   the highest worst-case price; settlement prices the model that actually
 *   ran, so a cheaper candidate can only mean over-reservation.
 * - Escalation FAST->STRONG and deterministic Tier-0 rules are not here:
 *   see ADR 012.
 */

export interface RoutedCandidate {
  readonly providerId: string;
  readonly model: string;
  readonly provider: LlmProvider;
  readonly capability: CapabilityView;
}

export interface RouterStats {
  readonly byProvider: Readonly<
    Record<string, { calls: number; errors: number; failoversFrom: number }>
  >;
  readonly failovers: number;
  readonly exhausted: number;
}

const FAILOVER_CODES: ReadonlySet<string> = new Set([
  'LLM_RATE_LIMITED',
  'LLM_QUOTA_EXHAUSTED',
  'LLM_UNAVAILABLE',
  'LLM_TIMEOUT',
  'LLM_UNSUPPORTED_FEATURE',
  'LLM_AUTHENTICATION',
]);

interface Wrapped {
  readonly routedBy: string;
  readonly inner: unknown;
}

function isWrapped(value: unknown): value is Wrapped {
  return (
    typeof value === 'object' &&
    value !== null &&
    'routedBy' in value &&
    'inner' in value
  );
}

/** Highest worst-case price per tier; also enforces the long-prompt rule. */
export function reservationModel(
  candidates: readonly RoutedCandidate[],
  snapshot: PricingSnapshot,
): string {
  if (candidates.length === 0) throw new Error('No candidates for tier');
  // Reference sizes: a full input at the budget's input ceiling is not known
  // here; compare unit costs for 1,000 input + 1,000 output tokens.
  const cost = (model: string): number =>
    worstCaseCost(pricingFor(snapshot, model), 1_000, 1_000);
  const ceiling = (model: string): number =>
    pricingFor(snapshot, model).longContext?.threshold ??
    Number.POSITIVE_INFINITY;
  const chosen = candidates.reduce((best, next) =>
    cost(next.model) > cost(best.model) ? next : best,
  );
  // The reservation model must dominate every candidate on each rate that
  // enters the worst case (standard and long-prompt input, output, cache
  // writes): a mixed ordering (cheap input, dear output) could otherwise let
  // a candidate settle above the reservation. Such a config is refused.
  const rates = (model: string): number[] => {
    const p = pricingFor(snapshot, model);
    return [
      p.standard,
      ...(p.longContext ? [p.longContext.rates] : []),
    ].flatMap((r) => [r.input, r.output, r.cacheWrite5m, r.cacheWrite1h]);
  };
  const chosenRates = rates(chosen.model);
  for (const candidate of candidates) {
    const other = rates(candidate.model);
    // Compare standard-tier components only when both have the same shape.
    const std = (r: number[]): number[] => r.slice(0, 4);
    if (std(other).some((value, i) => value > std(chosenRates)[i])) {
      throw new Error(
        `No candidate dominates the tier on every rate (${candidate.model} vs ${chosen.model}); refusing config`,
      );
    }
    if (ceiling(candidate.model) < ceiling(chosen.model)) {
      throw new Error(
        `Candidate ${candidate.model} has a lower long-prompt ceiling than reservation model ${chosen.model}; refusing config`,
      );
    }
  }
  return chosen.model;
}

export class RoutingLlmProvider implements LlmProvider {
  readonly providerId = 'routed';
  private readonly reservation: Record<LlmTier, string>;
  private readonly openUntil = new Map<string, number>();
  private readonly transientCount = new Map<string, number>();
  private readonly calls = new Map<
    string,
    { calls: number; errors: number; failoversFrom: number }
  >();
  private failovers = 0;
  private exhausted = 0;

  constructor(
    private readonly tiers: Readonly<Record<LlmTier, RoutedCandidate[]>>,
    private readonly policy: Pick<RoutingPolicy, 'breaker'>,
    snapshot: PricingSnapshot,
    private readonly now: () => number = Date.now,
    private readonly onFailover: (event: {
      tier: LlmTier;
      from: string;
      code: string;
    }) => void = () => undefined,
  ) {
    this.reservation = {
      FAST: reservationModel(tiers.FAST, snapshot),
      STRONG: reservationModel(tiers.STRONG, snapshot),
    };
  }

  modelFor(tier: LlmTier): string {
    return this.reservation[tier];
  }

  get stats(): RouterStats {
    return {
      byProvider: Object.fromEntries(this.calls),
      failovers: this.failovers,
      exhausted: this.exhausted,
    };
  }

  private providerKey(candidate: RoutedCandidate): string {
    return candidate.providerId;
  }
  private pairKey(candidate: RoutedCandidate): string {
    return `${candidate.providerId}/${candidate.model}`;
  }

  private open(key: string, ms: number): void {
    this.openUntil.set(key, this.now() + ms);
  }

  private isOpen(candidate: RoutedCandidate): boolean {
    const at = this.now();
    for (const key of [this.providerKey(candidate), this.pairKey(candidate)]) {
      const until = this.openUntil.get(key);
      if (until !== undefined) {
        if (until > at) return true;
        this.openUntil.delete(key);
      }
    }
    return false;
  }

  private record(candidate: RoutedCandidate, error: boolean): void {
    const entry = this.calls.get(candidate.providerId) ?? {
      calls: 0,
      errors: 0,
      failoversFrom: 0,
    };
    entry.calls += 1;
    if (error) entry.errors += 1;
    this.calls.set(candidate.providerId, entry);
  }

  private trip(candidate: RoutedCandidate, error: LlmError): void {
    const { breaker } = this.policy;
    switch (error.code) {
      case 'LLM_QUOTA_EXHAUSTED':
      case 'LLM_AUTHENTICATION':
        this.open(
          this.providerKey(candidate),
          Math.max(error.retryAfterMs ?? 0, breaker.providerCooldownMs),
        );
        break;
      case 'LLM_RATE_LIMITED':
        this.open(
          this.pairKey(candidate),
          Math.max(error.retryAfterMs ?? 0, breaker.rateLimitCooldownMs),
        );
        break;
      case 'LLM_UNSUPPORTED_FEATURE':
        this.open(this.pairKey(candidate), breaker.providerCooldownMs);
        break;
      case 'LLM_UNAVAILABLE':
      case 'LLM_TIMEOUT': {
        const count =
          (this.transientCount.get(this.pairKey(candidate)) ?? 0) + 1;
        this.transientCount.set(this.pairKey(candidate), count);
        if (count >= breaker.transientFailures) {
          this.open(this.pairKey(candidate), breaker.transientCooldownMs);
          this.transientCount.delete(this.pairKey(candidate));
        }
        break;
      }
      default:
        break;
    }
  }

  /** Provider-native content only goes back to the provider that made it. */
  private messagesFor(
    candidate: RoutedCandidate,
    messages: readonly LlmMessage[],
  ): LlmMessage[] {
    return messages.map((message) => {
      if (message.role !== 'assistant' || message.providerContent === undefined)
        return message;
      const mine =
        isWrapped(message.providerContent) &&
        message.providerContent.routedBy === this.pairKey(candidate);
      return {
        ...message,
        providerContent: mine
          ? (message.providerContent as Wrapped).inner
          : undefined,
      };
    });
  }

  private async route<R extends { attempts: number }>(
    tier: LlmTier,
    needs: 'tools' | 'structured' | 'text',
    signal: AbortSignal | undefined,
    run: (candidate: RoutedCandidate) => Promise<R>,
  ): Promise<{ result: R; candidate: RoutedCandidate }> {
    let attempts = 0;
    let last: LlmError | undefined;
    for (const candidate of this.tiers[tier]) {
      if (signal?.aborted)
        throw new LlmError('LLM_CANCELLED', 'Request cancelled', false);
      if (this.isOpen(candidate)) continue;
      if (needs === 'tools' && candidate.capability.tools === 'no') continue;
      if (needs === 'structured' && candidate.capability.structured === 'none')
        continue;
      try {
        const result = await run(candidate);
        this.record(candidate, false);
        this.transientCount.delete(this.pairKey(candidate));
        return {
          result: { ...result, attempts: result.attempts + attempts },
          candidate,
        };
      } catch (error: unknown) {
        if (!(error instanceof LlmError) || !FAILOVER_CODES.has(error.code))
          throw error;
        this.record(candidate, true);
        this.trip(candidate, error);
        attempts += 1;
        last = error;
        this.failovers += 1;
        const entry = this.calls.get(candidate.providerId);
        if (entry) entry.failoversFrom += 1;
        this.onFailover({
          tier,
          from: this.pairKey(candidate),
          code: error.code,
        });
      }
    }
    this.exhausted += 1;
    throw (
      last ??
      new LlmError(
        'LLM_UNAVAILABLE',
        'No routable provider (all candidates unhealthy or incapable)',
        false,
      )
    );
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const { result } = await this.route(
      request.tier,
      'structured',
      request.signal,
      (candidate) =>
        candidate.provider.generateStructured({
          ...request,
          messages: this.messagesFor(candidate, request.messages),
        }),
    );
    return result;
  }

  async generateWithTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    const needs = request.tools.length > 0 ? 'tools' : 'text';
    const { result, candidate } = await this.route(
      request.tier,
      needs,
      request.signal,
      (c) =>
        c.provider.generateWithTools({
          ...request,
          messages: this.messagesFor(c, request.messages),
        }),
    );
    return {
      ...result,
      providerContent:
        result.providerContent === undefined
          ? undefined
          : ({
              routedBy: this.pairKey(candidate),
              inner: result.providerContent,
            } satisfies Wrapped),
    };
  }
}
