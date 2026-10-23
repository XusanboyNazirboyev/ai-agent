# ADR 009: Agent turn pipeline (claim, compute, commit), agent mode and failure policy

- **Status:** Accepted for Phase 4B
- **Date:** 2026-10-24

## Context

Phase 2 builds each Telegram reply inside one PostgreSQL transaction that holds the conversation's advisory lock (ADR 005). That is fine for an echo. An LLM turn, though, takes seconds and calls external services. Holding a transaction, a row lock or a pooled connection for that long would starve the pool and block the webhook, whose acceptance needs the same lock. The agent was therefore not yet connected to any channel.

Connecting it also raises questions the echo never had:
- What if the customer writes again during a turn?
- What if an operator takes over?
- What if a worker crashes, or a job is delivered twice?
- What may the bot say when it fails, given that operator notification (Phase 5) does not exist yet?

## Decision

### Three steps per turn (`channels/telegram/telegram-agent-pipeline.ts`)

1. **Claim** (short transaction, same advisory lock as the webhook):
   - The conversation must be `BOT_ACTIVE`.
   - At most one `COMPUTING` `AgentTurn` may exist per conversation (partial unique index). A different job holding a live lease makes this job wait: BullMQ `moveToDelayed` plus `DelayedError`, which does not consume a retry attempt. This job's own earlier attempt, or an expired lease, is marked `ABANDONED` and its batch released.
   - The debounced batch (Phase 2 rules, now in `inbound-batch.ts`) is marked `PROCESSING`.
   - The turn records the answered sequence, the highest inbound sequence visible at claim time, the conversation version, the batch and a lease.
2. **Compute** (`AgentConversationService.compute`): no transaction and no lock. Context is read with short queries, and the turn runs under a whole-turn deadline (`AGENT_TURN_TIMEOUT_MS`, which aborts in-flight provider calls). Its only writes are LLM usage records, keyed by the attempt's turn id and idempotent on the provider response id, so cost is recorded once per attempt even if the worker dies.
3. **Commit** (short transaction, same lock):
   - The turn must still be this attempt's `COMPUTING` row. If not, it was taken over: drop the result (`LOST`).
   - If the conversation left `BOT_ACTIVE`, or its version changed (operator takeover): `DISCARDED`/`STATE_CHANGED`. The batch is closed and nothing is sent.
   - If an inbound message newer than the claim-time sequence exists: `DISCARDED`/`SUPERSEDED`. The batch returns to `RECEIVED` and the turn re-runs with the merged batch, at most three rounds. Messages that already existed at claim time but did not fit the batch do not supersede, so two jobs cannot keep discarding each other's replies.
   - Otherwise the following are written atomically: slots and language, `PROCESSED` events, the turn record and, in LIVE mode, the outbound message and its `telegram.send` outbox event. A handover outcome also writes a durable `Handover` and moves the conversation to `WAITING_OPERATOR`.

**Idempotency.** The key is `agent-reply:<conversationId>:<answeredSequence>`. A partial unique index allows one `COMMITTED` turn per key, and the outbound message carries the same key as `sendIdempotencyKey`. The handover key is `handover:<that key>`. Duplicate jobs find nothing pending. A crash between compute and commit leaves a `COMPUTING` row that the job's retry abandons; a new attempt then runs and bills again. Re-billing is accepted because each attempt is billed once and recorded once, which is cheaper than storing model output to resume. Non-idempotent external writes do not exist in this phase: all tools are READ, and Telegram's ambiguous-send handling (ADR 005) is unchanged.

### Agent mode per channel account (`ChannelAccount.agentMode`, default `OFF`)

- `OFF`: unchanged Phase 2 behavior (the echo path, now through the shared batch helper; all Phase 2 tests still pass).
- `SHADOW`: the full pipeline and turn record, including the draft. No message, no outbox event, no `Handover` row and no state change. The customer sees nothing.
- `LIVE`: sends. It requires an operator handover notifier, which does not exist until Phase 5, so it is allowed only with `NODE_ENV=development`. Elsewhere, startup fails if the served account is LIVE; `scripts/agent-mode.ts` refuses to set it; and a LIVE row is degraded to SHADOW at processing time, with an error logged.

### Failure policy

Each failure becomes a handover with a distinct reason and a locale template that says only that the message was recorded. It never claims that a person, or the CRM, has accepted anything.

| Failure | Reason |
|---|---|
| Provider error or timeout, or the whole-turn deadline | `LLM_UNAVAILABLE` |
| Cost, call or prompt-size limit | `BUDGET_EXCEEDED` |
| Tool round or call limit | `TOOL_LOOP_LIMIT` |
| CRM unreachable or invalid | `CONNECTOR_UNAVAILABLE`, distinct from `NO_DATA` (no data source or record) |
| A refusal, or a draft rejected twice | `GUARDRAIL` |

Only empty or truncated drafts still fall back to the code-rendered option list. In LIVE mode the `Handover` stays `notificationStatus = PENDING`, and the pipeline logs `handover.notification_pending` until Phase 5 delivers it.

### Pricing configuration

Prices moved out of the core into versioned config (`src/llm/pricing-catalog.ts`): decimal USD/MTok strings with model id, cache rates, the optional long-prompt tier (threshold and prices), `asOf` and `sourceUrl`. `core/llm/pricing.ts` converts them to integer nano-USD per token by string arithmetic and rejects any price that is not exact.

The worst-case reservation uses the tier the prompt falls in, at the highest input-side rate (including the 1h cache write). A prompt over the long-prompt threshold is refused (`INPUT_TOO_LARGE`), and startup validation keeps `LLM_MAX_INPUT_BYTES` below each running model's threshold. A warning is logged when `asOf` is more than 30 days old.

## Consequences

- No database resource is held while the model runs. The integration test proves this on a one-connection pool and through `pg_stat_activity`.
- The webhook and Phase 2 delivery are unchanged. Mode OFF keeps every Phase 2 test green.
- A superseded or discarded turn still costs money; the turn record keeps its cost and token counts.
- Re-running after a crash bills the provider again. This is bounded by the per-turn and per-conversation budgets.
- Shadow mode gives real-traffic drafts for review without customer exposure. It is the intended first step on a real channel.
- LIVE stays blocked outside development until Phase 5 provides the notifier. This ADR is then superseded in that one point.
