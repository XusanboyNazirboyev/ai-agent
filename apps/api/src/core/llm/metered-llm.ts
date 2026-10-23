import {
  BudgetExhaustedError,
  type Reservation,
  type TurnBudget,
} from './budget.js';
import { SinkBudgetLedger, type BudgetLedger } from './budget-ledger.js';
import {
  isLlmError,
  type AmbiguityHooks,
  type AmbiguousAttempt,
  type LlmMessage,
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
import {
  costOfUsage,
  maxStandardPromptTokens,
  pricingFor,
  worstCaseCost,
  type PricingSnapshot,
} from './pricing.js';

/** Per-message and per-request framing the provider adds around content. */
const MESSAGE_OVERHEAD_BYTES = 16;
/**
 * Tool-use preamble used when the pricing config does not state the model's
 * own figure (286 tokens on the priced Claude models, tool_choice auto).
 */
const DEFAULT_TOOLS_OVERHEAD_TOKENS = 400;

/**
 * Conservative input-size estimate taken before a call. Token counts are
 * bounded by UTF-8 byte counts for byte-level tokenizers, so bytes plus a
 * fixed overhead is used as the reservation estimate. It is a heuristic, not
 * a guarantee: settlement uses the provider-reported usage and records any
 * underestimate as overshoot.
 */
export function estimateRequest(
  request: {
    system: string;
    messages: readonly LlmMessage[];
    tools?: readonly LlmToolDefinition[];
    jsonSchema?: Readonly<Record<string, unknown>>;
  },
  toolsOverheadTokens: number = DEFAULT_TOOLS_OVERHEAD_TOKENS,
): { bytes: number; tokens: number } {
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
  const overhead = request.tools?.length ? toolsOverheadTokens : 0;
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
  /**
   * How the usage figures were obtained: `reported` by the provider,
   * `estimated` by an adapter from sizes, or `unknown` (a timed-out attempt
   * that may have been billed; cost is 0 and the exposure is bounded by
   * `reservedNano`). Persisted via `outcome` (`unknown_usage:<code>`).
   */
  readonly usageBasis: 'reported' | 'estimated' | 'unknown';
  readonly pricingVersion: string;
  readonly durationMs: number;
  readonly attempts: number;
  readonly outcome: string;
}

/** Durable usage recording; implementations must be idempotent on responseId. */
export interface LlmUsageSink {
  record(entry: LlmUsageEntry): Promise<boolean | void>;
}

export interface MeteringContext {
  readonly tenantId: string;
  readonly conversationId?: string;
  readonly turnKey: string;
  /** Turn deadline: aborts in-flight provider requests when it fires. */
  readonly signal?: AbortSignal;
}

/** Errors that prove the provider did not bill the attempt. */
const UNBILLED_CODES: ReadonlySet<string> = new Set([
  'LLM_RATE_LIMITED',
  'LLM_QUOTA_EXHAUSTED',
  'LLM_AUTHENTICATION',
  'LLM_INVALID_REQUEST',
  'LLM_UNSUPPORTED_FEATURE',
  'LLM_NOT_CONFIGURED',
  'LLM_UNAVAILABLE',
]);

interface CallState {
  readonly baseInvocationId: string;
  readonly callIndex: number;
  readonly tier: LlmTier;
  readonly purpose: LlmPurpose;
  readonly model: string;
  /** Local (in-memory) reservation of the attempt in flight. */
  reservation: Reservation | undefined;
  /** Durable reservation of the attempt in flight. */
  ledgerId: string | undefined;
  /** Timed-out attempts so far, for unique audit ids. */
  unknownCount: number;
}

/**
 * The only path from the agent core to a provider. Before every potentially
 * billable attempt it reserves the worst case twice: in the turn's memory
 * (`TurnBudget`) and durably (`BudgetLedger`, atomic per tenant and month).
 * After the call it settles the reported usage, or, when billing cannot be
 * determined (timeout, cancellation), keeps the reservation as unknown
 * exposure. Output ceilings are clamped to the configured per-call maximum.
 */
export class MeteredLlm {
  private callIndex = 0;
  private readonly ledger: BudgetLedger;

  constructor(
    private readonly provider: LlmProvider,
    private readonly pricing: PricingSnapshot,
    readonly budget: TurnBudget,
    private readonly sink: LlmUsageSink,
    private readonly context: MeteringContext,
    private readonly onRecordError: (error: unknown) => void = () => undefined,
    ledger?: BudgetLedger,
  ) {
    this.ledger = ledger ?? new SinkBudgetLedger(sink);
  }

  private prepare(
    request: Parameters<typeof estimateRequest>[0] & {
      readonly tier: LlmTier;
      readonly maxOutputTokens: number;
    },
  ): { model: string; reservation: Reservation; maxOutputTokens: number } {
    const model = this.provider.modelFor(request.tier);
    const pricing = pricingFor(this.pricing, model);
    const estimate = estimateRequest(
      request,
      pricing.toolUseSystemPromptTokens,
    );
    // Prompts must stay on the standard tier: a prompt over the long-prompt
    // threshold is refused instead of silently billed at the higher rates.
    const ceiling = maxStandardPromptTokens(pricing);
    if (ceiling !== undefined && estimate.tokens > ceiling)
      this.budget.refuseInput();
    const capped = Math.min(
      request.maxOutputTokens,
      this.budget.limits.maxOutputTokensPerCall,
    );
    const reservation = this.budget.reserve(
      worstCaseCost(pricing, estimate.tokens, capped),
      estimate.bytes,
      estimate.tokens + capped,
    );
    return { model, reservation, maxOutputTokens: capped };
  }

  private async persist(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error: unknown) {
      // The in-memory budget still counts the cost, and a reservation that
      // was not updated stays counted in the ledger: both fail conservative.
      this.onRecordError(error);
    }
  }

  private unknownEntry(
    state: CallState,
    reservation: Reservation,
    attempt: { providerId: string; model: string; code: string },
  ): LlmUsageEntry {
    state.unknownCount += 1;
    return {
      tenantId: this.context.tenantId,
      conversationId: this.context.conversationId,
      turnKey: this.context.turnKey,
      callIndex: state.callIndex,
      purpose: state.purpose,
      tier: state.tier,
      providerId: attempt.providerId,
      model: attempt.model,
      responseId: `unknown:${state.baseInvocationId}:${state.unknownCount}`,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      costNano: 0,
      reservedNano: reservation.worstCaseNano,
      usageBasis: 'unknown',
      pricingVersion: this.pricing.version,
      durationMs: 0,
      attempts: 1,
      outcome: `unknown_usage:${attempt.code}`.slice(0, 40),
    };
  }

  /** Billing of the attempt in flight cannot be determined: keep it counted. */
  private async accountUnknown(
    state: CallState,
    attempt: AmbiguousAttempt,
  ): Promise<void> {
    const { reservation, ledgerId } = state;
    if (!reservation) return;
    this.budget.addUnknownExposure(
      reservation.worstCaseNano,
      reservation.worstCaseTokens,
    );
    this.budget.release(reservation);
    state.reservation = undefined;
    state.ledgerId = undefined;
    if (ledgerId !== undefined) {
      await this.persist(() =>
        this.ledger.markUnknown(
          this.context.tenantId,
          ledgerId,
          this.unknownEntry(state, reservation, attempt),
        ),
      );
    }
  }

  /** Reserves one attempt in the turn budget and the durable ledger. */
  private async reserveAttempt(
    state: CallState,
    worstCaseNano: number,
    worstCaseTokens: number,
    bytes: number,
  ): Promise<void> {
    state.reservation = this.budget.reserve(
      worstCaseNano,
      bytes,
      worstCaseTokens,
    );
    try {
      const grant = await this.ledger.reserve({
        tenantId: this.context.tenantId,
        conversationId: this.context.conversationId,
        baseInvocationId: state.baseInvocationId,
        worstCaseNano,
        worstCaseTokens,
        monthlyCapNano: this.budget.limits.tenantMonthlyBudgetNano,
        conversationCapNano: this.budget.limits.maxConversationCostNano,
        conversationCapTokens: this.budget.limits.maxConversationTokens,
      });
      if (!grant.granted) {
        this.budget.release(state.reservation);
        state.reservation = undefined;
        this.budget.refuse(grant.reason);
      } else {
        state.ledgerId = grant.reservationId;
      }
    } catch (error: unknown) {
      if (state.reservation) this.budget.release(state.reservation);
      state.reservation = undefined;
      throw error;
    }
  }

  private async execute<R extends SettleInput>(
    request: {
      readonly tier: LlmTier;
      readonly purpose: LlmPurpose;
      readonly signal?: AbortSignal;
    },
    prep: ReturnType<MeteredLlm['prepare']>,
    call: (extras: {
      maxOutputTokens: number;
      ambiguity: AmbiguityHooks;
      signal: AbortSignal | undefined;
    }) => Promise<R>,
    outcomeOf: (result: R) => string,
  ): Promise<R> {
    const callIndex = this.callIndex++;
    const first = prep.reservation;
    // `prepare` already took the local reservation; the ledger follows.
    const state: CallState = {
      baseInvocationId: `${this.context.turnKey}:${callIndex}`,
      callIndex,
      tier: request.tier,
      purpose: request.purpose,
      model: prep.model,
      reservation: first,
      ledgerId: undefined,
      unknownCount: 0,
    };
    const { worstCaseNano, worstCaseTokens } = first;
    try {
      const grant = await this.ledger.reserve({
        tenantId: this.context.tenantId,
        conversationId: this.context.conversationId,
        baseInvocationId: state.baseInvocationId,
        worstCaseNano,
        worstCaseTokens,
        monthlyCapNano: this.budget.limits.tenantMonthlyBudgetNano,
        conversationCapNano: this.budget.limits.maxConversationCostNano,
        conversationCapTokens: this.budget.limits.maxConversationTokens,
      });
      if (!grant.granted) {
        this.budget.release(first);
        this.budget.refuse(grant.reason);
      } else {
        state.ledgerId = grant.reservationId;
      }
    } catch (error: unknown) {
      if (!(error instanceof BudgetExhaustedError)) this.budget.release(first);
      throw error;
    }
    const ambiguity: AmbiguityHooks = {
      onTimeout: (attempt) => this.accountUnknown(state, attempt),
      reserveNextAttempt: async () => {
        // The timed-out attempt is now exposure; another attempt must fit
        // beside it in the turn and in the tenant month, atomically.
        try {
          await this.reserveAttempt(state, worstCaseNano, worstCaseTokens, 0);
          return true;
        } catch (error: unknown) {
          if (error instanceof BudgetExhaustedError) return false;
          this.onRecordError(error);
          return false;
        }
      },
    };
    let result: R;
    try {
      result = await call({
        maxOutputTokens: prep.maxOutputTokens,
        ambiguity,
        signal: request.signal ?? this.context.signal,
      });
    } catch (error: unknown) {
      const { reservation, ledgerId } = state;
      if (reservation) {
        if (isLlmError(error) && UNBILLED_CODES.has(error.code)) {
          this.budget.release(reservation);
          if (ledgerId !== undefined) {
            await this.persist(() =>
              this.ledger.release(this.context.tenantId, ledgerId),
            );
          }
        } else {
          // Timeout, cancellation or an unexpected failure after the request
          // left: it may have been billed.
          await this.accountUnknown(state, {
            providerId: this.provider.providerId,
            model: prep.model,
            code: isLlmError(error) ? error.code : 'LLM_CANCELLED',
          });
        }
        state.reservation = undefined;
      }
      throw error;
    }
    await this.settle(state, result, outcomeOf(result));
    return result;
  }

  private async settle(
    state: CallState,
    result: SettleInput,
    outcome: string,
  ): Promise<void> {
    const reservation = state.reservation!;
    const cost = costOfUsage(
      pricingFor(this.pricing, result.model),
      result.usage,
    );
    const tokens =
      result.usage.inputTokens +
      result.usage.outputTokens +
      result.usage.cacheReadTokens +
      result.usage.cacheWrite5mTokens +
      result.usage.cacheWrite1hTokens;
    this.budget.settle(reservation, cost, tokens);
    state.reservation = undefined;
    const entry: LlmUsageEntry = {
      tenantId: this.context.tenantId,
      conversationId: this.context.conversationId,
      turnKey: this.context.turnKey,
      callIndex: state.callIndex,
      purpose: state.purpose,
      tier: state.tier,
      providerId: result.providerId,
      model: result.model,
      responseId: result.responseId,
      usage: result.usage,
      costNano: cost,
      reservedNano: reservation.worstCaseNano,
      usageBasis: result.usage.estimated ? 'estimated' : 'reported',
      pricingVersion: this.pricing.version,
      durationMs: result.durationMs,
      attempts: result.attempts,
      outcome,
    };
    const ledgerId = state.ledgerId;
    await this.persist(() =>
      ledgerId === undefined
        ? this.sink.record(entry).then(() => undefined)
        : this.ledger.settle(this.context.tenantId, ledgerId, entry),
    );
  }

  async structured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const prep = this.prepare(request);
    return this.execute(
      request,
      prep,
      (extras) => this.provider.generateStructured({ ...request, ...extras }),
      (result) => result.failure ?? 'ok',
    );
  }

  async withTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    const prep = this.prepare(request);
    return this.execute(
      request,
      prep,
      (extras) => this.provider.generateWithTools({ ...request, ...extras }),
      (result) => result.stopReason,
    );
  }
}

interface SettleInput {
  providerId: string;
  model: string;
  responseId: string;
  usage: LlmUsage;
  durationMs: number;
  attempts: number;
}

export { BudgetExhaustedError };
