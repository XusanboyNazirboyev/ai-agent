# ADR 038: An operator takes over a conversation at any time (AI | Operator switch)

- **Status:** Accepted, 2026-11-04 (owner, on staging, with a screenshot of the wanted header).
- **Context:**
  - An operator could write only after the bot asked for a handover (`WAITING_OPERATOR`). The owner wants the bot to answer by default and an operator to step in whenever they like, without a handover first.
  - D12 stays: the bot speaks only in `BOT_ACTIVE`. The Telegram pipeline already re-checks the state before it sends, so a reply in flight when the operator takes over is dropped.

## Decision
- **State machine:** `TAKE_OVER` is also legal from `BOT_ACTIVE` (→ `OPERATOR_ACTIVE`). No other transition changes.
- **API:** `POST /api/v1/handovers/by-conversation/:conversationId/take-over` (idempotency key, roles that may operate, tenant-scoped). It takes the open handover if there is one; otherwise it creates a handover with reason `OPERATOR_INITIATED`, status `TAKEN`, no SLA deadline and no operator-group notification. Audit `operator.take_over` with `via: "conversation"`. Taking a conversation another operator holds is refused (`ALREADY_TAKEN`, 409); the same operator again is a no-op.
- **Reply, return to bot, close:** unchanged; they use the handover the take-over returned.
- **Web:** the conversation header shows an **AI | Operator** switch.
  - "Operator" takes the conversation; "AI" returns it to the bot at once, without a confirmation dialog.
  - The composer is shown whenever the operator may write; the first character typed into it takes the conversation, and sending while not yet holding it takes it first and then sends.
  - Viewers see neither the switch nor the composer.

## Consequences
- The bot stops as soon as an operator starts typing; a reply it was preparing is not sent.
- An operator who forgets to switch back leaves the customer with no bot; the conversation stays in "Mine" until returned or closed (no auto-return yet).
- `OPERATOR_INITIATED` handovers count in handover lists and reports like any other taken handover; they never had an SLA.
