# ADR 023 — Connector write idempotency and durable operation records (Phase 7.0a)

Status: accepted and implemented on `phase6a/web-operator-inbox`. Implements the execution foundation of ADR 022 (which stays **proposed**; its owner decisions D-1…D-9 are still open). Related: ADR 006 (connector contract), ADR 018 (leads), `.claude/rules/connectors.md` ("no non-idempotent write is retried blindly").

## Root cause and the failure modes found
The lead job (`leads/lead-sync.service.ts`) called `connector.createLead(input)` with no idempotency information and retried every failure with backoff. Traced lifecycle (outbox → BullMQ `crm.lead.sync` → `sync()`):
1. **Lost response:** CRM commits, the response times out or the connection drops → retried → second CRM record.
2. **Concurrent jobs:** a re-score queues a second `crm.lead.sync` event (key includes level/reasons) while the first runs; two workers (or a stalled-job redelivery) call `createLead` at once → two records. There was no claim.
3. **Result not recorded:** CRM succeeds but the database update fails → the job throws → the queue retries → second record.
4. **Worker crash mid-call:** the lead stays `PENDING` forever (no recovery) — or, with naive recovery, a duplicate.
5. **Unclassified errors:** every failure counted the same; a 5xx after processing and a refused connection were indistinguishable.
The generic REST connector already sends writes exactly once per call (no internal retry) — the duplicates come from the job layer.

## Alternatives considered
| Option | Fixes | Does not fix / cost |
|---|---|---|
| A. Pass a key only (`createLead(input, {key})`) | 1 for CRMs that deduplicate natively | 2, 3, 4 for everyone; 1 for CRMs without deduplication; nothing records what happened |
| B. Claim on the lead row (`attempts` compare-and-set) + key | 1 (native), 2 | 3, 4 need a lease timestamp and an "unclear" state the lead row does not have; mixing CRM-attempt state into the domain row does not generalize to bookings/updates (ADR 022) |
| C. BullMQ job id dedup / queue-level locking | some of 2 | 1, 3, 4; queue state is not the source of truth (outbox is) |
| **D. Chosen: one durable `connector_operations` row per logical write**, stable derived key, lease, typed outcome, mode-aware recovery, lead row mirrored in the same transaction | 1 (native/lookup), 2, 3, 4, 5; honest UNCERTAIN for CRMs that cannot help | One additive table; small generic store |
D is the smallest option that covers all five failure modes and is exactly the execution record ADR 022 needs (its `action_executions` become `connector_operations` rows of kind `createLead`/`createBooking`/…, referenced by a proposal), so 7.0b does not need a second mechanism.

## Contract changes (`connectors/interfaces/crm-connector.ts`, `errors.ts`)
- `WriteContext { idempotencyKey }`, optional second argument of `createLead` and `createBooking` (backward compatible). Keys match `^[A-Za-z0-9:_-]{8,200}$`.
- `writeIdempotency?: 'native' | 'lookup' | 'none'` (default `none`); `findLeadByIdempotencyKey?(key)` required for `lookup` (registry refuses otherwise, and unknown modes).
- `ConnectorError.executed?: 'no' | 'unknown'` and `writeExecutionOf(error)`: `NOT_EXECUTED` only with proof (explicit `executed: 'no'`, or CONFIGURATION / AUTHENTICATION / AUTHORIZATION / VALIDATION / CAPABILITY / RATE_LIMITED); everything else — timeouts, 5xx, resets, unreadable success, unknown errors, non-connector errors — is `UNCERTAIN`.
- HTTP client: refused/unresolvable/unreachable connections, connect timeout and TLS handshake failure → `executed: 'no'`; 409 → `executed: 'unknown'` (often "same key in progress/exists"). Generic REST: circuit open → `executed: 'no'`.
- Generic REST config `writeIdempotency`: `{mode:'none'}` (default) | `{mode:'native', header}` (sent with the key on every attempt; must differ from an API-key auth header) | `{mode:'lookup', referenceField, referenceQueryParam?}` with the new `findLeadByReference` endpoint (404 or empty = not created; several records = `CONNECTOR_AMBIGUOUS_LOOKUP`, never a guess). Lookup mode refuses a create without a key (the record could never be found).
- Mock connector: `native` (deduplicates by key). Conformance suite: a `native` connector returns the same id for a repeated key; a `lookup` connector finds what it created and nothing else.

## Operation record (`connector_operations`, migration `20261102090000`)
Unique per `(tenant, kind, subject_type, subject_id)`; `idempotency_key = <kind>:<subjectType>:<subjectId>` (derived, identical for every attempt, never random). Status: `PENDING → IN_FLIGHT → SUCCEEDED | RETRY_WAIT | FAILED | UNCERTAIN`, then `RESOLVED_SUCCEEDED | RESOLVED_FAILED` by a person. CHECK constraints: success needs `external_id`; `IN_FLIGHT` needs a lease.
- **Claim**: compare-and-set on `(status, attempts)`; one winner. A live lease → `SKIPPED` (another worker). `RETRY_WAIT` before `next_attempt_at` → `SKIPPED` (redelivered jobs do not hammer the CRM). An expired lease → the attempt is *abandoned* (outcome unknown).
- **Lease**: 10 minutes (> the 300 s maximum connector deadline). Outcome writes are guarded by the lease token: a worker that lost its lease cannot overwrite.
- **Before an attempt** (`write-policy.ts`): if the previous attempt was unclear (UNCERTAIN or abandoned), retry only if the previous **and** current mode are both `native` (same key), look up first if both are `lookup`, otherwise stop as `UNCERTAIN` — a key sent to a system that did not honour it then cannot deduplicate it now.
- **After a failure**: `NOT_EXECUTED` → `RETRY_WAIT` with backoff up to 8 attempts, then `FAILED`; `UNCERTAIN` → `none`: `UNCERTAIN` immediately; `native`/`lookup`: `RETRY_WAIT` with the same key, and `UNCERTAIN` (not FAILED) when attempts run out. A failed lookup keeps the doubt (next attempt looks up again).
- **After success**: evidence (CRM id) recorded with the lead in one transaction, retried 3× in-process; if the database stays down the row stays `IN_FLIGHT` and is recovered after the lease (native: same key returns the same record; lookup: found; none: UNCERTAIN). A database failure is never treated as a CRM failure.
- **Scan** (`scanDue`): re-queues due retries (as before) and abandoned `IN_FLIGHT` writes.
- **Lead mirror**: `SYNCED` + `crmLeadId` on success; `FAILED` with the error code and `nextAttemptAt` while retrying; `FAILED` + `lastErrorCode = CRM_OUTCOME_UNCERTAIN` + no retry for UNCERTAIN.
- **Human recovery**: `LeadSyncService.resolveUncertain` (tenant-scoped, only UNCERTAIN rows, success needs the CRM id, audit `crm.operation.resolved`) and `pnpm --filter @agentcore/api crm:operations list|resolve`. No inbox UI yet (Phase 7.0b).

## Guarantees
| Proven by tests | Depends on the CRM | Not guaranteed |
|---|---|---|
| One stable key for every attempt of a lead; at most one attempt in flight per lead; redelivered/concurrent jobs make no second call; a provably unapplied write is retried, bounded; an unclear write under `none` is never retried automatically; a crash or lost result is recovered by mode; a stale worker cannot overwrite the outcome; resolution is tenant-scoped and audited | `native`: no duplicate across retries **only if** the CRM honours the key; `lookup`: correct recovery **only if** the lookup is reliable and the reference is stored | Exactly-once with `none` CRMs (we guarantee no blind retry + a person decides); exactly-once if a CRM's documented idempotency is wrong; the `executed: 'no'` classification of explicit 4xx assumes the CRM does not apply a write it rejects |

## Compatibility
- Additive migration; existing leads keep their columns. Leads that were `FAILED` before this change have no operation row: their next attempt creates one (treated as a first attempt — the pre-change history cannot be reconstructed).
- Behaviour change: an ambiguous failure on a `none` connector is no longer retried (was: retried up to 8 times, possibly duplicating). A terminal `FAILED` operation (8 provably unapplied attempts) is not retried by later re-score events.
- The one-off SLA test failure seen once locally during this work did not reproduce in later runs; unrelated to this change.

## Not done here (Phase 7.0b)
Proposal/confirmation, customer-facing outcome messages, inbox view and commands for UNCERTAIN writes, `createBooking` through the operation store, operation metrics in the analytics page.
