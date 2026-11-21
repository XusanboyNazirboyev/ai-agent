# ADR 005: Telegram durable acceptance, ordering, and send semantics

- **Status:** Accepted for Phase 2 implementation
- **Date:** 2026-10-22

## Context

Telegram may retry webhook requests, queues may redeliver after process failure, and parallel workers do not by themselves serialize work for one conversation. A crash can also occur after a remote send succeeds but before the API records success. The existing Phase 1 schema provides tenant-scoped inbound-event and outbox idempotency, messages, and delivery states.

## Decision

- Authenticate the official `X-Telegram-Bot-Api-Secret-Token` header before parsing or writing updates. Reject malformed text updates; acknowledge valid unsupported update kinds without storing them. Bound incoming JSON using Nest/Express's built-in JSON body parser limit and apply a PostgreSQL-backed per-channel fixed-window limit (default 120 accepted updates per minute, configurable).
- Bind this initial API process to one configured `ChannelAccount` UUID and one bot token/webhook secret. Resolve the tenant through that active database row; never derive tenant ownership from update content. This is a Phase 2 deployment boundary, not a persisted token store.
- In one PostgreSQL transaction, persist the provider update ID, normalized inbound message, and idempotent `telegram.inbound` outbox event. Return 2xx only after that transaction commits. The polling relay publishes durable outbox rows to BullMQ with the outbox ID as the queue job ID. A crash between queue publication and marking the outbox row published can cause re-publication; the database event/message states make that safe.
- Debounce inbound jobs for 2 seconds. A PostgreSQL advisory transaction lock serializes work per tenant/conversation. Under the lock, batch up to four pending messages for the same conversation, order them by Telegram message ID, mark them processed, and persist one joined echo reply plus a `telegram.send` outbox event. A later-arriving message older than the processed provider-message cursor is retained as `FAILED` for visibility rather than replied to out of order.
- BullMQ retries transient queue and explicit Telegram API failures up to five attempts, with bounded exponential delay and Telegram `retry_after` for 429 responses. Failed jobs remain in BullMQ and database status for inspection. Delivery attempts and a safe error code are stored on the outgoing message.
- Pending and processed conversation batches are selected through tenant/account-scoped JSON path predicates backed by PostgreSQL expression indexes on the normalized event summary.
- Before making the remote send call, move the message from `PENDING` to `UNKNOWN` atomically. A successful Bot API response changes it to `SENT`; an explicit transient API rejection changes it back to `PENDING` for retry; a permanent rejection changes it to `FAILED`. A network timeout, lost response, malformed response, or crash after the remote side effect leaves it `UNKNOWN` and is never blindly replayed. Telegram does not expose a send idempotency key for `sendMessage`, so exactly-once delivery cannot be claimed.

## Consequences

- PostgreSQL is the source of truth for acceptance and processing; Redis/BullMQ is the execution transport. Queue outage delays processing without losing acknowledged inbound updates.
- Message text is retained in the tenant-scoped `messages` table; the raw Telegram object is not persisted. Retention duration remains an open project decision.
- A late out-of-order Telegram update becomes a visible failed inbound event and needs operational recovery; it is not silently merged into a later turn.
- A single configured bot per API process is an initial integration limitation. Supporting multiple independently credentialed Telegram accounts requires a secret-reference resolver and channel-account routing before deployment expansion.
- Added `delivery_attempts`/`delivery_error_code` columns and a channel-scoped inbound-event index in the additive Phase 2 migration. Existing partial unique provider-message and send-idempotency indexes remain unchanged.

## Amendment 2026-11-21: 1 s debounce and early "typing…" (owner: the agent is too slow)

Measured on staging (Gemini Flash-Lite routing): a text reply took 4.3 s from the customer's message to the bot's, of which 2.7 s passed before the turn started (the 2 s debounce plus the 500 ms outbox poll) and 1.6 s in two model calls; a voice note waited about 6 s (debounce plus transcription) with nothing shown to the customer. The inbound debounce is now 1 s (`INBOUND_DEBOUNCE_MS`): a quick burst is still answered once, and a later message is still picked up by the next round. When the bot will answer (agent mode LIVE, conversation `BOT_ACTIVE`, Telegram), "typing…" now starts when the job starts, before a voice note is transcribed, instead of after it.
