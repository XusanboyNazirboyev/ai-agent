# ADR 028: Connecting a messenger channel from the web UI (proposal)

- **Status:** Accepted for Telegram (owner decisions D-A: encrypted in the database, scope S1-S4, 2026-10-25). S1 (secret store) and S2 (per-account Telegram credentials) are implemented on `feat/channel-secret-store`; S3 (connect/enable/test API) and S4 (Channels page) follow in later branches.
- **Date:** 2026-10-25

## Context
- Today one Telegram bot is served per process. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_CHANNEL_ACCOUNT_ID` come from the environment; `TelegramWebhookService`, `TelegramSender` and `telegram-bot-api` read them directly. The webhook is registered by the `telegram:live register` script.
- `ChannelAccount.credentialRef` / `webhookSecretRef` columns exist but nothing reads them for Telegram. Connector secrets use `env:CONNECTOR_SECRET_*` references, deployment-wide ([secret-resolver.ts](../../apps/api/src/connectors/registry/secret-resolver.ts)).
- Spec 10 and 09: channel connection (Telegram bot token now, Meta later) belongs to Tenant Admin; secrets in the UI are **write-only**; "secrets in env/secret manager; encryption at rest".
- So a "Connect Telegram" button is not a UI task: it needs per-account secret storage and a runtime that serves many bots.

## Decision (proposed)
1. **`ChannelSecretStore` interface** (`put`, `get`, `delete`, `exists`) with a first implementation that stores secrets **encrypted in PostgreSQL**: AES-256-GCM, a random nonce per value, associated data = `tenantId:channelAccountId:purpose` (a ciphertext cannot be replayed onto another account or purpose), a `keyId` column for rotation. The key comes from `SECRETS_MASTER_KEY` (32 bytes, base64) in the environment, never in the database; the interface lets a KMS/Vault implementation replace it. Plaintext exists only in memory while a call is made; never logged, returned or put in audit rows or error messages (extend log redaction).
2. **Per-account Telegram runtime.** The webhook route already carries the channel account id: resolve the account, load *its* webhook secret (compare in constant time) and bot token, instead of the env pair. Sender and Bot API client take credentials per call from a short-lived in-memory cache. The env trio stays as a development fallback for the one configured account, so nothing existing breaks.
3. **Connect flow (OWNER/ADMIN, CSRF, audited, rate limited):**
   - `POST /api/v1/channels/telegram` `{ botToken }`: format check, `getMe` against `api.telegram.org` (fixed host, no user-supplied URL), the bot id becomes `externalAccountId` (already globally unique, so one bot cannot be attached to two tenants), a random 32-byte webhook secret is generated, both secrets are stored encrypted, account is created **DISABLED**, `setWebhook` is called with `secret_token` and `allowed_updates` to `${PUBLIC_BASE_URL}/webhooks/telegram/<accountId>`. The response carries only the bot username, never a secret.
   - `POST .../:id/test`: `getMe` + `getWebhookInfo` (last error, pending count) shown as a checklist.
   - `PUT .../:id/operator-group` `{ chatId }`; `POST .../:id/enable` and `DELETE .../:id` (disconnect: `deleteWebhook`, wipe secrets, account DISABLED, conversations kept).
   - Replacing a token is a new `put` (write-only; the old one is overwritten).
4. **UI** (Channels page): a wizard Token → Verify (shows the bot's name) → Webhook → Test → Enable. The token field is write-only; after saving it is never shown, not even partly. Status comes from the test checklist, not from a stored flag.
5. **Gates:** the assistant mode rules of ADR 027 are unchanged; a freshly connected account is OFF. Telegram calls are tested with an injected transport; a real-Telegram check is a separate, explicitly authorized step and is reported as not run until then.

## Needs verification before coding (rule 7)
Exact Bot API semantics of `getMe`, `setWebhook` (`secret_token`, `allowed_updates`, `drop_pending_updates`), `getWebhookInfo`, `deleteWebhook` and their limits are to be checked against the official Telegram Bot API page and recorded with URL and date in the implementation PR. Nothing here is verified yet.

## Owner decisions
- **D-A: master key custody.** Environment variable now (acceptable for a pilot, the key must be backed up separately from the database), KMS/Vault later. Or do not store tokens at all (option B below).
- **D-B: public base URL** for the webhook (a tunnel in development, a real domain later): `PUBLIC_BASE_URL`, https only.
- **D-C: who may connect:** recommended OWNER and ADMIN.
- **D-D: one or several bots per tenant.** The schema allows several; recommended: several, each its own account.

## Alternatives considered
- **B. References only** (`credentialRef = env:NAME`, an operator provisions env vars): no key management and nothing sensitive in the database, but no self-service and every new bot is a deployment. Kept as the fallback resolver.
- Storing tokens in plaintext: rejected.

## Staging
S1 store + migration + tests (round trip, wrong account/purpose fails, rotation, no plaintext in DB/logs). S2 per-account runtime with env fallback (existing tests unchanged). S3 connect/test/disconnect API. S4 UI wizard. Each stage ends with tests and a PROGRESS entry; S3/S4 do not start before S1/S2 pass.

## Not in scope
Instagram/WhatsApp (Phase 8: tokens with expiry, 24-hour window, templates), inbound media, voice.
