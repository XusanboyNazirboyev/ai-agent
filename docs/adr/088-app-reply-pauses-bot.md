# ADR 088 — The bot steps back when a person answers from the Instagram or Messenger app

Status: built 2026-11-24 in autonomous mode (owner 2026-11-15); item 1 of the competitor gaps ([research](../research/competitors-2026-11-24.md)). Owner review pending.

## Context
- Sellers often answer a customer from the Instagram or Messenger app on their phone. The bot did not notice and kept answering the same customer, so two voices talked at once.
- Meta sends an "echo" for every message the business account sends, from any app (official docs, read 2026-11-24):
  - Instagram: echoes come in the `messages` field with `message.is_echo` (https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks). No `app_id` is documented.
  - Messenger: a separate `message_echoes` field; the echo has `is_echo`, `app_id` and `mid`, `sender` is the Page, `recipient` the customer (https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/message-echoes/).
- Our own sends echo too (every text part, carousels, audio, private replies), and an echo can arrive before our send call returns its id.

## Decisions
1. **Ours or a person's is decided by message id.** Every id Meta returns for one of our DM sends is recorded in Redis (`MetaSentLedger`, SHA-256 of the id, 24 h) inside `InstagramGraphClient.send`, the one path all DM sends take. `app_id` is not used: Instagram does not document it.
2. **The decision waits 15 s** (`META_ECHO_SETTLE_MS`): the webhook only writes a `meta.echo` outbox event with `availableAt` 15 s later (idempotent on the `mid`); the worker then checks the ledger and the stored outbound `provider_message_id`.
3. **A person's echo** (neither check matches) is stored as an OPERATOR outbound message (text, or empty for media), and the conversation goes `BOT_ACTIVE`/`WAITING_OPERATOR` → `OPERATOR_ACTIVE` (`TAKE_OVER`, no operator assigned). An open handover becomes TAKEN; otherwise a TAKEN handover with reason `OWNER_APP_REPLY` is created. Audit `conversation.app_reply_paused` (actor SYSTEM `meta-app-echo`). An echo with no conversation does nothing.
4. **Back to the bot** by the existing idle return (ADR 038 amendment 1): when the customer writes again and nobody answers for `OPERATOR_IDLE_RETURN_MINUTES`, the bot takes over and answers. No new setting.
5. **Messenger enable subscribes `messages,message_echoes`.**

## Consequences
- The seller can just answer from the phone; the inbox shows that reply in the conversation.
- Pages enabled before this keep `messages` only until disabled and enabled again; the Meta app's webhook settings must also include `message_echoes` (owner step).
- A send that timed out (ambiguous) has no recorded id, so its echo pauses the bot; the idle return recovers. Same for a Redis outage.
- Meta's own automatic replies (instant reply, saved replies sent from Meta Business Suite) look like a person and pause the bot until the customer's next message goes unanswered for the idle time.
- Not verified: a live echo from the Instagram app (shape of `recipient` in an echo is the Messenger shape; Instagram's page shows only `is_echo`). Verified with unit and integration tests only.
