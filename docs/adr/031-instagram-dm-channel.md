# ADR 031: Instagram direct messages as a channel adapter

Status: Proposed (2026-10-31). Slice 1 (pure core), slice 2a (GET verification handshake plus raw-body capture), and slice 2b (signed POST durable intake) are implemented on `feat/instagram-webhook-ingestion`; PR pending.

## Decision
Instagram is a channel adapter beside Telegram (D6). The LLM provider stays separate (D15): one key serves every channel. Slice 1 is pure, dependency-free code in `apps/api/src/channels/instagram/`:
- `verifyInstagramSignature`: HMAC-SHA256 of the raw body with the app secret, `X-Hub-Signature-256: sha256=<hex>`, constant-time compare, run before JSON parsing.
- `answerInstagramHandshake`: GET `hub.mode=subscribe` + `hub.verify_token` -> echo `hub.challenge`.
- `normalizeInstagramWebhook`: Zod-validated payload to channel-neutral events; echoes, self-test, deleted and text-less messages are ignored so the bot never answers itself.
- `evaluateMessagingWindow`: bot 24 hours from the customer's last message; a human operator up to 7 days with the `HUMAN_AGENT` tag. The window uses our receive time, not Meta's `timestamp` (its unit is not stated in the docs read).
- `splitInstagramText`: 1,000 BYTES per text message, split on whitespace, never inside a character.

## Sources (read 2026-10-31, official Meta pages)
- Webhook Notification Examples: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md
- Signature, handshake, windows and limits: `docs/research/channel-rules.md` (checked 2026-10-25).

## Not decided / unverified
- Attachment payload shape, the `timestamp` unit, and App Review and Business Verification lead times are unverified.
- Real customers need Advanced Access (App Review + Business Verification). The owner has no company documents yet, so until then only accounts with a role in the Meta app can be tested.

## Implementation status
- Slice 2a: NestJS `GET /webhooks/instagram` verifies `hub.mode`, `hub.verify_token`, and `hub.challenge`, failing closed when the token is missing or wrong. `NestFactory` preserves raw request bodies for the next POST/signature slice. Meta app secret and verify token are optional environment settings; no secrets are committed.
- POST checks the HMAC against Nest's captured raw body before using the parsed payload. Each text `mid` is stored once per active Instagram channel; contact, conversation, message, inbound event and outbox row are committed in one transaction. Echoes and unsupported/text-less messages are acknowledged as ignored.
- The outbox event type is `instagram.inbound`.
- Slice 3 (2026-11-02, branch `feat/instagram-dm-agent-reply`, stacked on `feat/instagram-webhook-ingestion`):
  - **Agent.** The outbox poller queues `instagram.inbound` (2 s debounce, as Telegram). The processor runs the shared agent pipeline: same modes, effective-mode degradation, handover and idempotent commit. With the assistant OFF nothing is sent (the Phase 2 echo stays Telegram-only).
  - **Batch order.** `inbound-batch.ts` orders by `orderKey` when present; Instagram intake stores its per-conversation message sequence there because a `mid` is opaque. Telegram, without `orderKey`, still orders by `providerMessageId`.
  - **Send.** Customer messages keep the one send queue (`telegram.send`, historical name). `processSend` routes by the account's channel type, so an Instagram message never reaches the Telegram sender. The Instagram path sends only inside 24 hours of the customer's last message (`conversations.last_inbound_at`). The HUMAN_AGENT tag is not used, because its request field is not stated on the pages read. Replies are split into 1,000-byte parts. Retryable Meta errors (codes 1, 2, 4, 17, 341, 368, 613; HTTP 429/5xx) go back to PENDING and are retried. Token (102, 190), permission (10, 200-299) and other errors fail. A lost response stays UNKNOWN. A failure after one part was sent fails `instagram_partial_send` and is never resent.
  - **Credentials.** Each account's Instagram User access token is stored encrypted (`channel_secrets`, purpose `instagram_access_token`). `POST /api/v1/channels/instagram` takes a pasted token, reads `GET /me?fields=user_id,username` (`user_id` is the webhook `entry[].id`), and creates the account DISABLED; another tenant's account is refused. `POST /api/v1/channels/instagram/:id/enable` calls `POST /<IG_ID>/subscribed_apps?subscribed_fields=messages`, and only with `INSTAGRAM_APP_SECRET` and `INSTAGRAM_VERIFY_TOKEN` set. `/disable` stops processing.
  - **Sources (read 2026-11-02).** Graph API version `v26.0` comes from these official pages:
    - https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
    - …/get-started
    - …/business-login
    - https://developers.facebook.com/documentation/instagram-platform/webhooks/setup.md
    - https://developers.facebook.com/docs/graph-api/guides/error-handling
  - **Tests.** A fake Meta transport covers intake, the agent and send end to end. `INSTAGRAM_API_BASE_URL` (test-only, refused in production) points the client at a fake server.

## Next slices
1. OAuth redirect connect (Business Login: `instagram.com/oauth/authorize`, code exchange, 60-day long-lived token) and token refresh (`ig_refresh_token`, at least 24 hours old) with expiry tracking; Channels page UI.
2. A live check with an app-role Instagram account under Standard Access (the app must be Live for webhooks); then App Review and Business Verification for the public.
3. Deliveries for a DISABLED account currently get 503 and Meta retries for up to 36 hours; decide whether to acknowledge and drop them. Comments and private replies (7-day rule) remain a separate decision.
