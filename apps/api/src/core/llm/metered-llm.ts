import {
  BudgetExhaustedError,
  type Reservation,
  type TurnBudget,
} from './budget.js';
import type {
  LlmMessage,
  LlmProvider,
  LlmPurpose,
  LlmTier,
  LlmToolDefinition,
  LlmUsage,
  StructuredGenerationRequest,
  StructuredGenerationResult,
  ToolGenerationRequest,
  ToolGenerationResult,
} from './llm-provider.js';
import { costOfUsage, pricingFor, worstCaseCost } from './pricing.js';

/** Per-message and per-request framing the provider adds around content. */
const MESSAGE_OVERHEAD_BYTES = 16;
/** Covers provider tool-use preambles (286 tokens on the priced models). */
const TOOLS_OVERHEAD_TOKENS = 400;

/**
 * Conservative input-size estimate taken before a call. Token counts are
 * bounded by UTF-8 byte counts for byte-level tokenizers, so bytes plus a
 * fixed overhead is used as the reservation estimate. It is a heuristic, not
 * a guarantee: settlement uses the provider-reported usage and records any
 * underestimate as overshoot.
 */
export function estimateRequest(request: {
  system: string;
  messages: readonly LlmMessage[];
  tools?: readonly LlmToolDefinition[];
  jsonSchema?: Readonly<Record<string, unknown>>;
}): { bytes: number; tokens: number } {
  const size = (value: string): number => Buffer.byteLength(value, 'utf8');
  let bytes = size(request.system);
  for (const message of request.messages) {
    bytes += MESSAGE_OVERHEAD_BYTES;
    if (message.role === 'user') bytes += size(message.text);
    if (message.role === 'assistant') {
      bytes += size(message.text) + size(JSON.stringify(message.toolCalls));
    }
    if (message.role === 'tool_results') {
      for (const result of message.results) bytes += size(result.content) + 32;
    }
  }
  if (request.tools?.length) bytes += size(JSON.stringify(request.tools));
  if (request.jsonSchema) bytes += size(JSON.stringify(request.jsonSchema));
  const overhead = request.tools?.length ? TOOLS_OVERHEAD_TOKENS : 0;
  return { bytes, tokens: bytes + overhead };
}

export interface LlmUsageEntry {
  readonly tenantId: string;
  readonly conversationId: string | undefined;
  readonly turnKey: string;
  readonly callIndex: number;
  readonly purpose: LlmPurpose;
  readonly tier: LlmTier;
  readonly providerId: string;
  readonly model: string;
  readonly responseId: string;
  readonly usage: LlmUsage;
  readonly costNano: number;
  readonly reservedNano: number;
  readonly pricingVersion: string;
  readonly durationMs: number;
  readonly attempts: number;
  readonly outcome: string;
}

/** Durable usage recording; implementations must be idempotent on responseId. */
export interface LlmUsageSink {
  record(entry: LlmUsageEntry): Promise<void>;
}

export interface MeteringContext {
  readonly tenantId: string;
  readonly conversationId?: string;
  readonly turnKey: string;
}

/**
 * The only path from the agent core to a provider: reserve worst-case cost,
 * call, settle the actual cost, record usage. Output ceilings are clamped to
 * the configured per-call maximum.
 */
export class MeteredLlm {
  private callIndex = 0;

  constructor(
    private readonly provider: LlmProvider,
    private readonly pricingVersion: string,
    readonly budget: TurnBudget,
    private readonly sink: LlmUsageSink,
    private readonly context: MeteringContext,
    private readonly onRecordError: (error: unknown) => void = () => undefined,
  ) {}

  private prepare(
    tier: LlmTier,
    maxOutputTokens: number,
    estimate: { bytes: number; tokens: number },
  ): { model: string; reservation: Reservation; maxOutputTokens: number } {
    const model = this.provider.modelFor(tier);
    const pricing = pricingFor(this.pricingVersion, model);
    const capped = Math.min(
      maxOutputTokens,
      this.budget.limits.maxOutputTokensPerCall,
    );
    const reservation = this.budget.reserve(
      worstCaseCost(pricing, estimate.tokens, capped),
      estimate.bytes,
    );
    return { model, reservation, maxOutputTokens: capped };
  }

  private async settle(
    tier: LlmTier,
    purpose: LlmPurpose,
    reservation: Reservation,
    result: {
      providerId: string;
      model: string;
      responseId: string;
      usage: LlmUsage;
      durationMs: number;
      attempts: number;
    },
    outcome: string,
  ): Promise<void> {
    const cost = costOfUsage(
      pricingFor(this.pricingVersion, result.model),
      result.usage,
    );
    this.budget.settle(reservation, cost);
    try {
      await this.sink.record({
        tenantId: this.context.tenantId,
        conversationId: this.context.conversationId,
        turnKey: this.context.turnKey,
        callIndex: this.callIndex++,
        purpose,
        tier,
        providerId: result.providerId,
        model: result.model,
        responseId: result.responseId,
        usage: result.usage,
        costNano: cost,
        reservedNano: reservation.worstCaseNano,
        pricingVersion: this.pricingVersion,
        durationMs: result.durationMs,
        attempts: result.attempts,
        outcome,
      });
    } catch (error: unknown) {
      // The in-memory budget still counts the cost; only persistence failed.
      this.onRecordError(error);
    }
  }

  async structured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const prep = this.prepare(
      request.tier,
      request.maxOutputTokens,
      estimateRequest(request),
    );
    let result: StructuredGenerationResult<T>;
    try {
      result = await this.provider.generateStructured({
        ...request,
        maxOutputTokens: prep.maxOutputTokens,
      });
    } catch (error: unknown) {
      this.budget.release(prep.reservation);
      throw error;
    }
    await this.settle(
      request.tier,
      request.purpose,
      prep.reservation,
      result,
      result.failure ?? 'ok',
    );
    return result;
  }

  async withTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    const prep = this.prepare(
      request.tier,
      request.maxOutputTokens,
      estimateRequest(request),
    );
    let result: ToolGenerationResult;
    try {
      result = await this.provider.generateWithTools({
        ...request,
        maxOutputTokens: prep.maxOutputTokens,
      });
    } catch (error: unknown) {
      this.budget.release(prep.reservation);
      throw error;
    }
    await this.settle(
      request.tier,
      request.purpose,
      prep.reservation,
      result,
      result.stopReason,
    );
    return result;
  }
}

export { BudgetExhaustedError };
