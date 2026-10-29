# Telegram dev runbook (web-connected test bot, secret store)

How a developer tests the Telegram flow end to end with their own test bot, connected from the web Channels page (bot token in the encrypted secret store, not in `.env`). The CI-only and env-variable procedure stays in [TELEGRAM_TEST_PROCEDURE.md](TELEGRAM_TEST_PROCEDURE.md).

**Rules for every run**
- Only a dedicated test bot, a private test group and your own Telegram account. Synthetic messages only; never real customers or real customer data.
- Provider `mock` first. A free-tier provider only if it stays **untrusted** (not in `LLM_TRUSTED_PROVIDERS`), so it can never run LIVE and runs SHADOW only on a test account.
- **No LIVE run before webhook-secret rotation exists and has been exercised** (owner decision 2026-10-28; slice 1c, not built). With `NODE_ENV=development` and the trusted `mock` provider the code would allow LIVE (`liveModeRefusal`, `apps/api/src/agent/agent-mode.ts`), but the rule does not.
- **Rollback is Disable only** (step 9). **Off is not a rollback:** in mode Off the bot echoes every customer message back to the sender (the Phase 2 echo).
- Secrets are never pasted into chat, logs, tickets or commits. This document names variables, never values.

**Depends on two branches not yet merged** (2026-10-28): `feat/telegram-enable-drop-pending` (step 6, the checkbox) and `feat/dev-test-account-script` (step 3). Until they are merged, the fallback is given in those steps.

## 0. Before you start
- A test bot from BotFather; a private Telegram group with only you and the bot (the bot as an administrator that can read messages).
- Local Postgres and Redis running; `pnpm install`; migrations applied (`pnpm db:migrate`).
- A web login: `pnpm --filter @agentcore/api dev:superadmin` (OWNER of the local tenant `dev-local-superadmin`; the password goes to a file outside the repository, never printed).

## 1. Environment (names only, in `.env`)
- `NODE_ENV=development`, `API_HOST=127.0.0.1`.
- `SECRETS_MASTER_KEY` (32 random bytes, base64) and `SECRETS_KEY_ID`: needed to store the bot token.
- `WEB_ORIGINS` with the web address you open (`localhost` and `127.0.0.1` are different origins).
- `LLM_PROVIDER=mock` (default) and `LLM_TRUSTED_PROVIDERS=mock` (default).
- Do **not** set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_CHANNEL_ACCOUNT_ID` for the API: one credential source only.
- `PUBLIC_BASE_URL` is set in step 5.

## 2. Connect the bot
Channels page → Connect Telegram → paste the bot token. The API checks it with `getMe`, stores it encrypted with a generated webhook secret, and creates the account `DISABLED` with the assistant Off. No webhook is registered yet. Note the account id (UUID): `GET /api/v1/channels` (signed in), or the `id` of the row in `channel_accounts` whose `display_name` is the bot's @username.

## 3. Mark it as a test account (no UI, by owner decision)
```
pnpm --filter @agentcore/api channel:test-account dev-local-superadmin <account-uuid> on
```
Development and localhost only; the account must belong to the named tenant; the change is audited. It prints what the agent would run now (for example SHADOW, or HOLD: no reply). Not merged yet: until `feat/dev-test-account-script` is merged, stay on the `mock` provider, which does not need the flag.

## 4. Operator group
Channels page → Operator group → the test group's chat id (a negative number). Handover cards go there.

## 5. Tunnel to the webhook route only
1. `TELEGRAM_CHANNEL_ACCOUNT_ID=<account-uuid> pnpm --filter @agentcore/api telegram:proxy` (127.0.0.1:4100). It forwards only `POST /webhooks/telegram/<account-uuid>` and logs only counters and status codes.
2. A quick tunnel to the proxy, for example `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4100`.
3. Put the tunnel's https address in `PUBLIC_BASE_URL` and **restart the API**: the value is read at start. A quick-tunnel address changes on every run.

## 6. Enable, skipping old messages
Channels page → Enable. With `feat/telegram-enable-drop-pending` merged, the checkbox "Skip messages sent while the bot was off" is ticked for the first enable of an account (Telegram's `drop_pending_updates`); leave it ticked for a test run. Not merged yet: web Enable keeps Telegram's pending updates, so send nothing to the bot before this step, or use the env-variable path in [TELEGRAM_TEST_PROCEDURE.md](TELEGRAM_TEST_PROCEDURE.md) with `TELEGRAM_DROP_PENDING_UPDATES=true`.

Then Channels page → Check connection: the token works, the webhook is registered at the expected address, the pending-update count.

## 7. SHADOW run
AI bot page → Drafts only. From your own account, send synthetic messages to the bot. Check:
- `agent_turns` gets a SHADOW turn per message batch; **no message is sent** to you by the assistant;
- the AI bot page shows what really runs (with the effective-mode branch merged: a notice when the selected mode cannot run here, for example HOLD, "customers get no reply").

## 8. Rotation
- **Bot token:** revoke it in BotFather, then Connect again with the new token (the stored webhook secret is kept).
- **Webhook secret:** no rotation path yet (slice 1c, planned with an ADR 028 amendment). Required before any LIVE run.
- **Master key:** a new `SECRETS_MASTER_KEY` with a new `SECRETS_KEY_ID`, the old key listed in `SECRETS_PREVIOUS_KEYS` (see `.env.example`). Re-encrypting old rows is not verified.

## 9. Rollback: Disable only
1. Channels page → **Disable**. This removes the webhook at Telegram; nothing reaches the API any more.
2. Stop the tunnel and the proxy.
3. Disconnect (deletes the stored token) only if wanted, after Disable.

Never use Off to stop the bot: Off echoes each customer's message back to them.

## 10. Record
Write the date, commit, provider, mode and outcome in `docs/PROGRESS.md` as "live, test bot", and say which steps were not run.
