import {
  LlmError,
  type LlmProvider,
  type LlmTier,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type ToolGenerationRequest,
  type ToolGenerationResult,
} from '../core/llm/llm-provider.js';
import { estimateRequest } from '../core/llm/metered-llm.js';

/**
 * Client-side request limiter so the app stays inside a provider's quota
 * (e.g. a free tier). Limits are configuration: free-tier limits are per
 * account and per model (Gemini shows them in AI Studio, not in its docs),
 * so no numbers are built in.
 *
 * - RPM and TPM use 60-second sliding windows; TPM counts estimated input
 *   tokens (UTF-8 bytes, an upper bound), matching Gemini's "tokens per
 *   minute (input)".
 * - RPD uses a rolling 24-hour window. That is stricter than a quota that
 *   resets at a fixed time of day, so it never exceeds one.
 * - A call that would exceed RPM/TPM waits up to `maxWaitMs`, then fails as
 *   LLM_RATE_LIMITED; an exhausted RPD fails as LLM_QUOTA_EXHAUSTED. Both
 *   lead to the LLM_UNAVAILABLE handover, never to a guardrail failure.
 * - State is per process. Several API processes sharing one key need a
 *   shared limiter (not built).
 */

export interface RateLimits {
  readonly requestsPerMinute?: number;
  readonly tokensPerMinute?: number;
  readonly requestsPerDay?: number;
  readonly maxWaitMs: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

export class ClientRateLimiter {
  private readonly minute: Array<{ at: number; tokens: number }> = [];
  private readonly day: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limits: RateLimits,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Admits one request of `tokens` estimated input tokens, or throws. */
  acquire(tokens: number): Promise<void> {
    // Serialize admissions so concurrent turns cannot overshoot together.
    const next = this.queue.then(() => this.admit(tokens));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private prune(at: number): void {
    while (this.minute.length > 0 && this.minute[0].at <= at - MINUTE)
      this.minute.shift();
    while (this.day.length > 0 && this.day[0] <= at - DAY) this.day.shift();
  }

  /** Milliseconds until the request fits the per-minute limits. */
  private waitFor(tokens: number, at: number): number {
    const { requestsPerMinute: rpm, tokensPerMinute: tpm } = this.limits;
    let wait = 0;
    if (rpm !== undefined && this.minute.length >= rpm) {
      wait = Math.max(
        wait,
        this.minute[this.minute.length - rpm].at + MINUTE - at,
      );
    }
    if (tpm !== undefined) {
      if (tokens > tpm) return Number.POSITIVE_INFINITY;
      let used = this.minute.reduce((sum, entry) => sum + entry.tokens, 0);
      for (const entry of this.minute) {
        if (used + tokens <= tpm) break;
        used -= entry.tokens;
        wait = Math.max(wait, entry.at + MINUTE - at);
      }
    }
    return wait;
  }

  private async admit(tokens: number): Promise<void> {
    let at = this.now();
    this.prune(at);
    const rpd = this.limits.requestsPerDay;
    if (rpd !== undefined && this.day.length >= rpd) {
      throw new LlmError(
        'LLM_QUOTA_EXHAUSTED',
        'Client-side daily request limit reached',
        false,
      );
    }
    const wait = this.waitFor(tokens, at);
    if (wait > this.limits.maxWaitMs) {
      throw new LlmError(
        'LLM_RATE_LIMITED',
        'Client-side rate limit: no capacity within the wait limit',
        false,
      );
    }
    if (wait > 0) {
      await this.sleep(wait);
      at = this.now();
      this.prune(at);
    }
    this.minute.push({ at, tokens });
    this.day.push(at);
  }
}

/** Wraps any provider with a ClientRateLimiter. */
export class RateLimitedLlmProvider implements LlmProvider {
  readonly providerId: string;

  constructor(
    private readonly inner: LlmProvider,
    private readonly limiter: ClientRateLimiter,
  ) {
    this.providerId = inner.providerId;
  }

  modelFor(tier: LlmTier): string {
    return this.inner.modelFor(tier);
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    await this.limiter.acquire(estimateRequest(request).tokens);
    return this.inner.generateStructured(request);
  }

  async generateWithTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    await this.limiter.acquire(estimateRequest(request).tokens);
    return this.inner.generateWithTools(request);
  }
}
