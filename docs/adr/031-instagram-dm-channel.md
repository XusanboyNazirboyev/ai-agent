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
- The outbox event type is `instagram.inbound`; no Instagram worker consumes it yet. This slice stores inbound messages durably but does not run the agent or send replies.

## Next slices
1. Add an Instagram outbox publisher/worker and channel-neutral agent-pipeline adapter; do not route Instagram jobs through the Telegram sender or silently acknowledge unconsumed work.
2. Add encrypted secret-purpose handling and an Instagram sender with the messaging-window gate, channel-mode parity, and channel-account connection UX.
3. Fake Meta server and end-to-end tests; comments/private replies (7-day rule) remain a separate decision.
