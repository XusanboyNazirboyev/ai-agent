# ADR 028: Connecting a messenger channel from the web UI (proposal)

- **Status:** Accepted for Telegram (owner decisions D-A: encrypted in the database, scope S1-S4, 2026-10-25). Instagram is a documented plan only (see Instagram below).
  - **Implemented here** (`feat/channel-secret-store`, for `main`): S1 secret store and S2 per-account Telegram credentials.
  - **Present only on `web/design-pages`, not implemented here:** S3 (connect / enable / disable / test / disconnect API, channel list with capabilities) and S4 (Channels page wizard). They are recorded under "As built on `web/design-pages`" below and must be ported, reviewed and tested before they count as implemented on `main`.
- **Date:** 2026-10-25 (status and sections reconciled with the `web/design-pages` text on 2026-10-26)

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
5. **Gates:** the assistant mode rules (the `agent:mode` command; ADR 027 is only proposed) are unchanged; a freshly connected account is OFF. Telegram calls are tested with an injected transport; a real-Telegram check is a separate, explicitly authorized step and is reported as not run until then.

## As built on `web/design-pages` (differences from the proposal; S3/S4 reference, not on this branch)
Recorded on `web/design-pages` (S3 `389f4de`, `3e48d49`; S4 `30ca64a`) and kept here unchanged as the reference for porting S3/S4:
- Webhook registration moved from *connect* to *enable*: a connected but disabled bot has no webhook, so Telegram does not deliver updates that would be refused. Order: connect (validate with `getMe`, store token and a generated webhook secret, account DISABLED, assistant OFF) → enable (`setWebhook`, then ACTIVE) → disable (`deleteWebhook`, DISABLED, assistant OFF) → disconnect (also deletes the stored secrets; the account row stays because conversations belong to it).
- Reconnecting the same bot (same Telegram bot id) in the same tenant replaces the token and keeps the webhook secret; the same bot in another tenant is refused with `ALREADY_CONNECTED` (no hint about who owns it).
- `ChannelAccount.displayName` (the bot's @username) was added (additive migration). `GET /api/v1/channels` returns `capabilities` (is `SECRETS_MASTER_KEY` set, is `PUBLIC_BASE_URL` set) and a `webhookUrl`; never a secret.
- `TELEGRAM_API_BASE_URL` points the management calls at a fake Telegram in tests; the environment schema refuses it in production.
- A secret that cannot be decrypted counts as missing (logged without any value); the account then answers 503 on its webhook instead of failing open. *(This part is S2 and is implemented here.)*
- Rate limit: 10 management calls per minute per operator (in memory, per API process).

Known review points for the S3 port (from reading `389f4de`, 2026-10-26; not yet fixed anywhere): account creation maps every database error to `ALREADY_CONNECTED` (only a unique-key violation should); account creation and secret storage are not atomic (a failure leaves a DISABLED account without a token); connecting the bot that is also the env-configured fallback account would create a second account and move its webhook on enable; no test yet proves a token never reaches logs, audit rows or errors (including fetch errors that carry `/bot<token>/` URLs).

## Instagram (plan, not built)
From Meta's documentation (Instagram API with Instagram Login, messaging, read 2026-10-25): an Instagram **professional** account; a Meta app with permissions `instagram_business_basic` and `instagram_business_manage_messages`; **Advanced Access** (app review) when serving accounts you do not own or manage, Standard Access for your own; an Instagram User access token; webhook fields `messages`, `messaging_optins`, `messaging_postbacks`, `messaging_reactions`, `messaging_referrals`, `messaging_seen`; send with `POST graph.instagram.com/<IG_ID>/messages` (`recipient.id` = the sender's Instagram-scoped id, `message`); you can message a person only after they wrote first, within 24 hours (7 days after a Click-to-Direct ad, or a separate 7-day human-agent window); text UTF-8 up to 1000 bytes; group chats unsupported; no stated rate limits on that page. Needed for the adapter (Phase 8): webhook signature verification, token storage with expiry and refresh (the same `ChannelSecretStore`), window logic, an `instagram` channel type behind the channel adapter layer (D6). Until then the Channels page shows these steps on the Instagram card and offers no connect button. Exact token lifetime/refresh rules and App Review requirements must be re-read at implementation time.

## Telegram Bot API facts (rule 7)
- **2026-10-25** (`web/design-pages`), against https://core.telegram.org/bots/api: `getMe` (no parameters, returns a User), `setWebhook` (`url` https, `secret_token` 1-256 chars of A-Z a-z 0-9 _ -, sent as the header X-Telegram-Bot-Api-Secret-Token, `allowed_updates`, `drop_pending_updates`, ports 443/80/88/8443), `deleteWebhook` (`drop_pending_updates`), `getWebhookInfo` (`url`, `pending_update_count`, `last_error_date`, `last_error_message`), response envelope (`ok`, `result`, `description`, `error_code`, `parameters.retry_after`); no rate limits are stated for these calls.
- **Re-read 2026-10-26** (page shows Bot API 10.3, 2026-08-24): confirmed `setWebhook` `url` (HTTPS), `secret_token` (1-256 characters, `A-Z a-z 0-9 _ -`, header `X-Telegram-Bot-Api-Secret-Token`), `allowed_updates`, `drop_pending_updates`, ports 443/80/88/8443; `deleteWebhook(drop_pending_updates)`; the four `getWebhookInfo` fields; the `ok` / `result` / `error_code` envelope and optional `parameters`. Not re-read on 2026-10-26 (page truncated in the reader): `getMe` and `ResponseParameters.retry_after`.
- **Not verified:** which HTTP status Telegram returns for a wrong bot token (the S3 code treats 401 and 404 as an invalid token), and everything against the live service: no real Telegram call was made.

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

| Stage | On this branch | Elsewhere |
|---|---|---|
| S1 secret store, migration `20261104090000_channel_secrets` | implemented, tested | identical on `web/design-pages` |
| S2 per-account credentials | implemented, tested | identical on `web/design-pages` |
| S3 API, migration `20261105090000_channel_display_name` | not here | `web/design-pages` only; also needs the channel list (`channels.controller.ts`, `channel-summary.ts`) that is not on `main` |
| S4 Channels page | not here | `web/design-pages` only; needs that branch's web app shell |

## Migrations
- `20261104090000_channel_secrets` (S1, this branch): sha256 `9750052eb33874771e165cc1d8a756720665508364d041f97aed50e446cbd1c9`, byte-identical to `web/design-pages`.
- `20261105090000_channel_display_name` (S3, `web/design-pages` `389f4de`, not on this branch): sha256 `12b448ba3893a28030d3f804436360c4869d22462ad5f4916b9d4123516f9cce` (`ALTER TABLE "channel_accounts" ADD COLUMN "display_name" VARCHAR(200);`). Local databases that ran `web/design-pages` (`agentcore`, `agentcore_test`) already recorded both migrations with these checksums. The S3 port must carry this file **byte for byte** under the same name, or those databases report a checksum mismatch. Until S3 lands, a schema drift check on those two databases will show the extra column.

## Before production (mandatory, not done)
- **Key rotation script.** `SECRETS_PREVIOUS_KEYS` only keeps old keys readable; nothing re-encrypts stored rows with the current key. A rotation command (re-encrypt every `channel_secrets` row under `SECRETS_KEY_ID`, report counts, never print values) is required before production. **An old key must stay in `SECRETS_PREVIOUS_KEYS` until no row uses its `key_id`**; removing it earlier makes those secrets unreadable (they count as missing and the account's webhook answers 503).
- Key custody beyond an environment variable (KMS/Vault, D-A) and a real `PUBLIC_BASE_URL` (D-B).

## Not in scope
Instagram/WhatsApp (Phase 8: tokens with expiry, 24-hour window, templates), inbound media, voice.
