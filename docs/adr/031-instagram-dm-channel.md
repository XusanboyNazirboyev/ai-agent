# ADR 031: Instagram direct messages as a channel adapter

Status: Proposed (2026-10-31). Slice 1 (pure core) is implemented; the NestJS wiring is not.

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

## Next slices
1. Webhook controller (raw-body capture, signature, 200 fast, queue by `mid`), per-tenant app secret in the secret store, sender with the window gate, channel account type, effective-mode parity. Needs the database, so it is verified in CI.
2. Fake Meta server for end-to-end tests; comments (private replies, 7-day rule) as a separate decision.
