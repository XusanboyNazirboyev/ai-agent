# Telegram test procedure (test bot and test group only)

For a bot connected from the web Channels page (token in the secret store), follow [TELEGRAM_DEV_RUNBOOK.md](TELEGRAM_DEV_RUNBOOK.md) instead of the env-variable steps below.

Never use a production bot, production customers or real customer data. Never paste secrets into chat or commit them; values live in the gitignored `.env.local`.

## In CI (no network)
The operator flow is covered with a mocked transport by `pnpm --filter api test:integration`:
- `handover/phase5.integration.spec.ts`: card with take-over button posted once, customer follow-ups forwarded under the card, take-over by button (one winner, redelivery changes nothing), strangers/other chats ignored, operator replies/notes/commands only through a handover message, no cross-tenant action.
- `handover/handover.integration.spec.ts`: race between workers, reply delivered to the customer only for the assigned operator, `/return` gives control back, closed conversations reopen.
- `channels/telegram/telegram-agent.integration.spec.ts`: bot silent and customer forwarded while `OPERATOR_ACTIVE`.

## Live (only with valid local credentials and a test group)
Required environment variables (names only): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CHANNEL_ACCOUNT_ID`, `TELEGRAM_TEST_PUBLIC_URL` (https tunnel to port 4000). Database: the channel account has `operator_chat_id` set to the test group and `is_test_account = true`.

1. `pnpm --filter api telegram:live check` lists missing variables by name and stops. If any is missing, **the live test is not run** and must be reported as not run.
2. `pnpm --filter api telegram:live register` calls `setWebhook` with `allowed_updates: ["message","callback_query"]` and the secret token; it prints only `ok`/HTTP status.
3. Add the bot to the test group as an administrator that can read messages. Send a message to the bot from a test account; trigger a handover; check the card, the take-over button, a reply (delivered to the customer), bot silence, `/return`.
4. Record the result with date in `docs/PROGRESS.md` as "live, test bot".
