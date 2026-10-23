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
}

export type BudgetStopReason =
  | 'TURN_COST_LIMIT'
  | 'CONVERSATION_COST_LIMIT'
  | 'TENANT_MONTHLY_LIMIT'
  | 'CALL_LIMIT'
  | 'TOOL_ROUND_LIMIT'
  | 'TOOL_CALL_LIMIT'
  | 'INPUT_TOO_LARGE';

export class BudgetExhaustedError extends Error {
  constructor(readonly reason: BudgetStopReason) {
    super(`LLM budget exhausted: ${reason}`);
    this.name = 'BudgetExhaustedError';
  }
}

export interface Reservation {
  readonly id: number;
  readonly worstCaseNano: number;
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
  readonly stopReason: BudgetStopReason | undefined;
}

export class TurnBudget {
  private spent = 0;
  private reserved = 0;
  private calls = 0;
  private toolRounds = 0;
  private toolCalls = 0;
  private overshoot = 0;
  private nextId = 1;
  private readonly open = new Map<number, number>();
  private stop: BudgetStopReason | undefined;

  constructor(
    readonly limits: BudgetLimits,
    private readonly prior: {
      readonly conversationSpentNano: number;
      readonly tenantMonthSpentNano: number;
    },
  ) {}

  private fail(reason: BudgetStopReason): never {
    this.stop ??= reason;
    throw new BudgetExhaustedError(reason);
  }

  /** Reserves a call; throws BudgetExhaustedError instead of overspending. */
  reserve(worstCaseNano: number, inputBytes: number): Reservation {
    if (!Number.isSafeInteger(worstCaseNano) || worstCaseNano < 0) {
      throw new RangeError('worst-case cost must be a non-negative integer');
    }
    if (this.calls >= this.limits.maxCallsPerTurn) this.fail('CALL_LIMIT');
    if (inputBytes > this.limits.maxInputBytesPerCall)
      this.fail('INPUT_TOO_LARGE');
    const committed = this.spent + this.reserved + worstCaseNano;
    if (committed > this.limits.maxTurnCostNano) this.fail('TURN_COST_LIMIT');
    if (
      this.prior.conversationSpentNano + committed >
      this.limits.maxConversationCostNano
    ) {
      this.fail('CONVERSATION_COST_LIMIT');
    }
    const monthly = this.limits.tenantMonthlyBudgetNano;
    if (
      monthly !== undefined &&
      this.prior.tenantMonthSpentNano + committed > monthly
    ) {
      this.fail('TENANT_MONTHLY_LIMIT');
    }
    this.calls += 1;
    this.reserved += worstCaseNano;
    const id = this.nextId++;
    this.open.set(id, worstCaseNano);
    return { id, worstCaseNano };
  }

  /** Replaces a reservation with the provider-reported actual cost. */
  settle(reservation: Reservation, actualNano: number): void {
    const worst = this.take(reservation);
    this.spent += actualNano;
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
    this.reserved -= worst;
    return worst;
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
        this.limits.maxTurnCostNano - this.spent - this.reserved,
      ),
      remainingConversationNano: Math.max(
        0,
        this.limits.maxConversationCostNano -
          this.prior.conversationSpentNano -
          this.spent -
          this.reserved,
      ),
      overshootNano: this.overshoot,
      stopReason: this.stop,
    };
  }
}
