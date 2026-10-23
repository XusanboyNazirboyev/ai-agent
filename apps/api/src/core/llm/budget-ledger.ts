import type { LlmUsageEntry, LlmUsageSink } from './metered-llm.js';

/**
 * Durable, cross-process budget reservations (ADR 014). `TurnBudget` guards
 * one turn in memory; the ledger makes the tenant-month cap atomic across
 * workers and conversations: a worst-case amount is reserved before every
 * potentially billable provider invocation and reconciled afterwards.
 *
 * Reserved or unknown exposure is never spend: settled usage is the only
 * thing recorded as cost.
 */

export interface LedgerReserveRequest {
  readonly tenantId: string;
  readonly conversationId?: string;
  /** `<turnKey>:<callIndex>`, stable across job retries. */
  readonly baseInvocationId: string;
  readonly worstCaseNano: number;
  readonly worstCaseTokens: number;
  /** Tenant monthly cap in nano-USD; unset = track but do not enforce. */
  readonly monthlyCapNano?: number;
  /**
   * Conversation lifetime caps, enforced in the same transaction. They make
   * the conversation budget safe even when two turns of one conversation
   * overlap (e.g. a lease taken over from a slow worker).
   */
  readonly conversationCapNano?: number;
  readonly conversationCapTokens?: number;
}

export type LedgerReserveResult =
  | { readonly granted: true; readonly reservationId: string }
  | {
      readonly granted: false;
      readonly reason:
        | 'TENANT_MONTHLY_LIMIT'
        | 'CONVERSATION_COST_LIMIT'
        | 'CONVERSATION_TOKEN_LIMIT';
    };

export interface BudgetLedger {
  /**
   * Atomically verifies actual spend + outstanding/unknown exposure + this
   * amount against the cap and records the reservation. Fails closed: a
   * persistence error rejects, it never grants.
   */
  reserve(request: LedgerReserveRequest): Promise<LedgerReserveResult>;
  /** Records provider-reported usage and ends the reservation, atomically. */
  settle(
    tenantId: string,
    reservationId: string,
    entry: LlmUsageEntry,
  ): Promise<void>;
  /**
   * Billing cannot be determined (timeout, cancellation): keep the worst case
   * counted and record an audit entry with cost 0.
   */
  markUnknown(
    tenantId: string,
    reservationId: string,
    entry: LlmUsageEntry,
  ): Promise<void>;
  /** The attempt was certainly not billed: stop counting it. */
  release(tenantId: string, reservationId: string): Promise<void>;
}

/** No cross-process state: reservations are only the in-memory turn budget. */
export class SinkBudgetLedger implements BudgetLedger {
  constructor(private readonly sink: LlmUsageSink) {}

  reserve(): Promise<LedgerReserveResult> {
    return Promise.resolve({ granted: true, reservationId: 'in-memory' });
  }

  async settle(
    _tenantId: string,
    _reservationId: string,
    entry: LlmUsageEntry,
  ): Promise<void> {
    await this.sink.record(entry);
  }

  async markUnknown(
    _tenantId: string,
    _reservationId: string,
    entry: LlmUsageEntry,
  ): Promise<void> {
    await this.sink.record(entry);
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}
