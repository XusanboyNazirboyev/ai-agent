# ADR 014: Atomic tenant-month LLM budget reservations

- **Status:** Accepted (Stage C correction)
- **Date:** 2026-10-25

## Context
`TurnBudget` guards one turn in memory and reads persisted totals once at the start. Two conversations of one tenant, or two workers, could each see the same remaining monthly budget and both spend it. Timed-out attempts (billing unknown) were counted only inside their own turn and against cost, not tokens ([ADR 013](013-stage-c-safety-gates.md)).

## Decision
- **Table `llm_budget_reservations`** (additive migration `20261025090000`): one row per real provider invocation: `tenant_id`, `conversation_id`, `base_invocation_id` (`<turnKey>:<callIndex>`), `invocation_id` (`<base>#<n>`, unique per tenant), `period_start` (UTC month), `reserved_nano_usd`, `reserved_tokens`, `state`, `expires_at`. Check constraints on state and non-negative amounts. It is separate from `llm_usage_records`, so reserved exposure is never mistaken for spend (spend = provider-reported cost only).
- **States.** `RESERVED` (in flight) → `SETTLED` (usage recorded) | `UNKNOWN` (billing cannot be determined) | `RELEASED` (certainly unbilled). `RESERVED` and `UNKNOWN` count against budgets; `SETTLED` and `RELEASED` do not.
- **Atomic admission.** `LlmBudgetLedger.reserve` runs a short transaction under `pg_advisory_xact_lock` keyed by tenant: recover, check `SUM(cost this month) + SUM(RESERVED+UNKNOWN this month) + new ≤ cap`, insert. Serialization is per tenant, so any number of processes and conversations see each other's reservations. No transaction is open while a provider call runs. A persistence error rejects (fail closed); `MeteredLlm` then releases its in-memory reservation and the turn fails/retries.
- **Order in `MeteredLlm`:** in-memory `TurnBudget.reserve` (cheap, per turn) then the ledger. A ledger denial stops the call with `TENANT_MONTHLY_LIMIT` before any provider request.
- **Reconciliation.** Success: `settle` inserts the usage record and marks the row `SETTLED` in one transaction (idempotent on the provider response id and on row state), so exposure and spend are never both counted for one call. A late completion of a row already turned `UNKNOWN` may also settle it: provider-reported usage justifies replacing the worst case.
- **Unknown billing.** `LLM_TIMEOUT`, `LLM_CANCELLED` and unexpected failures after the request left keep the row as `UNKNOWN` (cost 0 in spend, audit entry `unknown_usage:<code>`, `usageBasis: 'unknown'`). Only provider errors that prove no billing (rate limit, quota, auth, invalid request, unsupported, not configured, unavailable) release the row.
- **Failover after a timeout.** The router reports each timeout (`onTimeout`) and may start another attempt only after `reserveNextAttempt()` succeeds: a fresh in-memory and ledger reservation. If either refuses, the timeout is thrown and the call ends.
- **Retries and crashes.** A retried job re-reserves the same base id: any unfinished earlier row of that base becomes `UNKNOWN` (the lost invocation may have been billed) and the retry gets its own `#n` row, since it is a real second provider invocation. A `RESERVED` row past `expires_at` (crashed worker) becomes `UNKNOWN` at the next reservation of the tenant; it is never freed automatically. No double counting: one row per invocation; settlement ends it.
- **Tokens.** `reserved_tokens` records the request-size-based worst case (estimated input + capped output ceiling). `TurnBudget` counts unknown tokens in-turn (`unknownExposureTokens`) and persisted unknown/reserved tokens of the conversation (`conversationExposureTokens`) against the turn and conversation token caps, separately from confirmed usage (`tokensUsed`). The token numbers are reservations, not measurements; no usage is invented.
- **Preload for the in-memory check.** The service loads conversation and tenant-month exposure from the ledger (`RESERVED+UNKNOWN`) and passes it as `*Exposure*` next to `*Spent*`. The ledger remains the authority for the tenant-month cap.

## Limits (accepted)
- Per-conversation caps are checked in memory from values loaded at turn start; they rely on one turn at a time per conversation (D7 ordering). Only the tenant month is atomic across conversations.
- Exposure of an `UNKNOWN` row stays counted for the month until a late settlement; there is no operator tool to write it off yet (add with Phase 9 ops work).
- No tenant-month **token** cap exists, so tokens are enforced per turn and per conversation only.
- Reservation lifetime is 10 minutes (`LlmBudgetLedger.configure`); a call slower than that is recovered as `UNKNOWN` and corrected on settlement.
