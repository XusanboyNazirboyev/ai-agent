# ADR 031: Instagram direct messages as a channel adapter

Status: Proposed (2026-10-31). Slice 1 (pure core) and slice 2a (GET verification handshake plus raw-body capture) are implemented on `feat/instagram-dm-webhook`; POST intake is not wired.

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
- The GET handshake does not imply inbound POST works. POST has no route yet, and messages are not queued or answered.

## Next slices
1. POST webhook: verify `X-Hub-Signature-256` against `rawBody` before parsing; resolve the active Instagram channel; durably store each event with `mid` idempotency and queue it through the existing agent pipeline. Do not acknowledge success before durable acceptance.
2. Add encrypted secret-purpose handling and an Instagram sender with the messaging-window gate, channel-mode parity, and channel-account connection UX.
3. Fake Meta server and end-to-end tests; comments/private replies (7-day rule) remain a separate decision.
