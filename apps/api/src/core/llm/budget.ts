/**
 * Per-turn LLM budget (all money in integer nano-USD).
 *
 * A call may start only after its worst-case cost is reserved against the
 * turn, conversation and (optional) tenant-monthly limits; afterwards the
 * reservation is replaced by the provider-reported actual cost. A post-hoc
 * check alone could not bound spend, so the reservation is the hard limit;
 * `maxOutputTokensPerCall` makes the output side of that bound exact.
 */

export interface BudgetLimits {
  readonly maxTurnCostNano: number;
  readonly maxConversationCostNano: number;
  readonly maxCallsPerTurn: number;
  readonly maxToolRoundsPerTurn: number;
  readonly maxToolCallsPerTurn: number;
  readonly maxOutputTokensPerCall: number;
  readonly maxInputBytesPerCall: number;
  readonly tenantMonthlyBudgetNano?: number;
  /**
   * Token caps (input + output, worst case reserved before each call). They
   * bound zero-priced models too, so a free model cannot loop endlessly.
   */
  readonly maxTurnTokens?: number;
  readonly maxConversationTokens?: number;
}

export type BudgetStopReason =
  | 'TURN_COST_LIMIT'
  | 'CONVERSATION_COST_LIMIT'
  | 'TENANT_MONTHLY_LIMIT'
  | 'CALL_LIMIT'
  | 'TOOL_ROUND_LIMIT'
  | 'TOOL_CALL_LIMIT'
  | 'INPUT_TOO_LARGE'
  | 'TURN_TOKEN_LIMIT'
  | 'CONVERSATION_TOKEN_LIMIT';

export class BudgetExhaustedError extends Error {
  constructor(readonly reason: BudgetStopReason) {
    super(`LLM budget exhausted: ${reason}`);
    this.name = 'BudgetExhaustedError';
  }
}

export interface Reservation {
  readonly id: number;
  readonly worstCaseNano: number;
  readonly worstCaseTokens: number;
}

export interface BudgetSnapshot {
  readonly spentNano: number;
  readonly reservedNano: number;
  readonly calls: number;
  readonly toolRounds: number;
  readonly toolCalls: number;
  readonly remainingTurnNano: number;
  readonly remainingConversationNano: number;
  readonly overshootNano: number;
  /** Upper bound for attempts that may have been billed with unknown usage. */
  readonly unknownExposureNano: number;
  /** Reserved tokens of attempts with unknown usage (not confirmed usage). */
  readonly unknownExposureTokens: number;
  readonly tokensUsed: number;
  readonly stopReason: BudgetStopReason | undefined;
}

export class TurnBudget {
  private spent = 0;
  private reserved = 0;
  private calls = 0;
  private toolRounds = 0;
  private toolCalls = 0;
  private overshoot = 0;
  private unknown = 0;
  private unknownTokens = 0;
  private tokens = 0;
  private reservedTokens = 0;
  private nextId = 1;
  private readonly open = new Map<
    number,
    { readonly nano: number; readonly tokens: number }
  >();
  private stop: BudgetStopReason | undefined;

  constructor(
    readonly limits: BudgetLimits,
    private readonly prior: {
      readonly conversationSpentNano: number;
      readonly tenantMonthSpentNano: number;
      readonly conversationTokensUsed?: number;
      /**
       * Worst-case exposure of earlier attempts with unknown usage (timeouts
       * that may have been billed), kept apart from `*SpentNano`, which holds
       * only reported cost. Counted against the limits, never reported as
       * spend.
       */
      readonly conversationExposureNano?: number;
      readonly tenantMonthExposureNano?: number;
      /** Reserved tokens of earlier attempts with unknown usage. */
      readonly conversationExposureTokens?: number;
    },
  ) {}

  private conversationCommitted(turnCommitted: number): number {
    return (
      this.prior.conversationSpentNano +
      (this.prior.conversationExposureNano ?? 0) +
      turnCommitted
    );
  }

  private monthCommitted(turnCommitted: number): number {
    return (
      this.prior.tenantMonthSpentNano +
      (this.prior.tenantMonthExposureNano ?? 0) +
      turnCommitted
    );
  }

  private conversationTokens(turnTokens: number): number {
    return (
      (this.prior.conversationTokensUsed ?? 0) +
      (this.prior.conversationExposureTokens ?? 0) +
      turnTokens
    );
  }

  /** Stops the turn because a limit outside this object (e.g. the tenant-month ledger) denied a call. */
  refuse(reason: BudgetStopReason): never {
    this.fail(reason);
  }

  private fail(reason: BudgetStopReason): never {
    this.stop ??= reason;
    throw new BudgetExhaustedError(reason);
  }

  /** Reserves a call; throws BudgetExhaustedError instead of overspending. */
  reserve(
    worstCaseNano: number,
    inputBytes: number,
    worstCaseTokens = 0,
  ): Reservation {
    if (!Number.isSafeInteger(worstCaseNano) || worstCaseNano < 0) {
      throw new RangeError('worst-case cost must be a non-negative integer');
    }
    if (!Number.isSafeInteger(worstCaseTokens) || worstCaseTokens < 0) {
      throw new RangeError('worst-case tokens must be a non-negative integer');
    }
    if (this.calls >= this.limits.maxCallsPerTurn) this.fail('CALL_LIMIT');
    if (inputBytes > this.limits.maxInputBytesPerCall)
      this.fail('INPUT_TOO_LARGE');
    const committed = this.spent + this.unknown + this.reserved + worstCaseNano;
    if (committed > this.limits.maxTurnCostNano) this.fail('TURN_COST_LIMIT');
    if (
      this.conversationCommitted(committed) >
      this.limits.maxConversationCostNano
    ) {
      this.fail('CONVERSATION_COST_LIMIT');
    }
    const monthly = this.limits.tenantMonthlyBudgetNano;
    if (monthly !== undefined && this.monthCommitted(committed) > monthly) {
      this.fail('TENANT_MONTHLY_LIMIT');
    }
    const tokens =
      this.tokens + this.unknownTokens + this.reservedTokens + worstCaseTokens;
    if (
      this.limits.maxTurnTokens !== undefined &&
      tokens > this.limits.maxTurnTokens
    ) {
      this.fail('TURN_TOKEN_LIMIT');
    }
    if (
      this.limits.maxConversationTokens !== undefined &&
      this.conversationTokens(tokens) > this.limits.maxConversationTokens
    ) {
      this.fail('CONVERSATION_TOKEN_LIMIT');
    }
    this.calls += 1;
    this.reserved += worstCaseNano;
    this.reservedTokens += worstCaseTokens;
    const id = this.nextId++;
    this.open.set(id, { nano: worstCaseNano, tokens: worstCaseTokens });
    return { id, worstCaseNano, worstCaseTokens };
  }

  /**
   * Whether one more call of this worst-case size would still be admitted.
   * Non-throwing mirror of the limit checks in `reserve`.
   */
  canReserve(worstCaseNano: number, worstCaseTokens = 0): boolean {
    const committed = this.spent + this.unknown + this.reserved + worstCaseNano;
    const tokens =
      this.tokens + this.unknownTokens + this.reservedTokens + worstCaseTokens;
    const monthly = this.limits.tenantMonthlyBudgetNano;
    return (
      this.calls < this.limits.maxCallsPerTurn &&
      committed <= this.limits.maxTurnCostNano &&
      this.conversationCommitted(committed) <=
        this.limits.maxConversationCostNano &&
      (monthly === undefined || this.monthCommitted(committed) <= monthly) &&
      (this.limits.maxTurnTokens === undefined ||
        tokens <= this.limits.maxTurnTokens) &&
      (this.limits.maxConversationTokens === undefined ||
        this.conversationTokens(tokens) <= this.limits.maxConversationTokens)
    );
  }

  /**
   * Counts an attempt that may have been billed with unknown usage (a
   * timeout) at its worst-case size against this turn's limits. It is an
   * upper bound, not a charge: persisted spend is unaffected.
   */
  addUnknownExposure(worstCaseNano: number, worstCaseTokens: number): void {
    this.unknown += worstCaseNano;
    this.unknownTokens += worstCaseTokens;
  }

  /** Replaces a reservation with the provider-reported actual cost. */
  settle(reservation: Reservation, actualNano: number, actualTokens = 0): void {
    const worst = this.take(reservation);
    this.spent += actualNano;
    this.tokens += actualTokens;
    // Input size is estimated before the call; record any underestimate.
    if (actualNano > worst) this.overshoot += actualNano - worst;
  }

  /** Releases a reservation for a call that produced no billable response. */
  release(reservation: Reservation): void {
    this.take(reservation);
  }

  private take(reservation: Reservation): number {
    const worst = this.open.get(reservation.id);
    if (worst === undefined) throw new Error('Unknown or settled reservation');
    this.open.delete(reservation.id);
    this.reserved -= worst.nano;
    this.reservedTokens -= worst.tokens;
    return worst.nano;
  }

  /** Rejects a call whose prompt would exceed the allowed size. */
  refuseInput(): never {
    this.fail('INPUT_TOO_LARGE');
  }

  beginToolRound(): void {
    if (this.toolRounds >= this.limits.maxToolRoundsPerTurn)
      this.fail('TOOL_ROUND_LIMIT');
    this.toolRounds += 1;
  }

  countToolCall(): void {
    if (this.toolCalls >= this.limits.maxToolCallsPerTurn)
      this.fail('TOOL_CALL_LIMIT');
    this.toolCalls += 1;
  }

  get snapshot(): BudgetSnapshot {
    return {
      spentNano: this.spent,
      reservedNano: this.reserved,
      calls: this.calls,
      toolRounds: this.toolRounds,
      toolCalls: this.toolCalls,
      remainingTurnNano: Math.max(
        0,
        this.limits.maxTurnCostNano - this.spent - this.unknown - this.reserved,
      ),
      remainingConversationNano: Math.max(
        0,
        this.limits.maxConversationCostNano -
          this.prior.conversationSpentNano -
          (this.prior.conversationExposureNano ?? 0) -
          this.spent -
          this.unknown -
          this.reserved,
      ),
      overshootNano: this.overshoot,
      unknownExposureNano: this.unknown,
      unknownExposureTokens: this.unknownTokens,
      tokensUsed: this.tokens,
      stopReason: this.stop,
    };
  }
}
