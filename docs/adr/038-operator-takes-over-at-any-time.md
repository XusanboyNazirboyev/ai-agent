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
- An operator who forgets to switch back leaves the customer with no bot; the conversation stays in "Mine" until returned or closed, or until amendment 1 returns it.
- `OPERATOR_INITIATED` handovers count in handover lists and reports like any other taken handover; they never had an SLA.

## Amendment 1: an idle operator hands the conversation back (2026-11-04, owner: 2 minutes)
- A scan in the existing 30-second background pass returns an `OPERATOR_ACTIVE` conversation to the bot when the customer's latest message has had no reply (operator or bot) for `OPERATOR_IDLE_RETURN_MINUTES` (default 2; 0 turns it off) and the operator took it at least that long ago. `WAITING_OPERATOR` is not touched: the bot itself asked for a human there.
- Under the conversation lock: state `BOT_ACTIVE`, open/taken handovers `RESOLVED`, audit `system.operator_idle_return` (actor `SYSTEM`). The customer's unanswered messages (at most 4, the pipeline's batch size) are set back to `RECEIVED` and one `telegram.inbound` / `instagram.inbound` event is queued, so the bot answers them like newly arrived messages.
- The operator can take the conversation back at any time by typing again.
- One setting for the whole deployment for now; a per-tenant setting in the web settings is a follow-up.
