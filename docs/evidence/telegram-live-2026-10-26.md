# Telegram live check, 2026-10-25/26 (test bot, test group, mock LLM)

Authorized by the owner in the session ("env da token va guruh bor, boshla"; permission rule for `scripts/telegram-session.sh` added by the owner). Test account (`is_test_account=true`), SHADOW mode, mock LLM. Tokens, secrets, tunnel URLs and chat ids are not recorded here.

## What ran
`apps/api/scripts/telegram-session.sh`: API on 127.0.0.1, the one-route proxy, a Cloudflare quick tunnel, `setWebhook` (allowed_updates message + callback_query, pending updates kept). Cleanup (webhook deleted, processes stopped) was observed after each session; final `getWebhookInfo`: not registered, 0 pending.

## Observed (real Telegram)
| Check | Result |
|---|---|
| Bot token valid (`getMe`), bot is administrator of the operator group (`getChat`, `getChatMember`) | pass |
| Customer messages reach the webhook through tunnel + proxy, secret header accepted, stored once, `PROCESSED`, agent turn recorded (`ASKED_SLOT`, nothing sent in SHADOW) | pass (3 messages) |
| Handover card posted to the operator group by the notifier (this runs the per-account credential path of ADR 028 S2 with the environment fallback) | pass, `notificationStatus=SENT` |
| "Take over" button by an operator row matched on the Telegram user id | pass (audit `operator.take_over`, state OPERATOR_ACTIVE) |
| Operator reply to the card delivered to the customer chat | pass (outbound OPERATOR message `SENT`, seen by the owner) |
| "Return to bot" button | pass (audit `operator.return_to_bot`, conversation BOT_ACTIVE, handover RESOLVED) |
| SLA customer notice ("your message was forwarded...") sent once | observed |
| Reply to a card after the conversation returned to the bot | refused with the "not possible in the current state" notice (correct) |

## Not simulated by the model, not verified
- The handover was opened by a script with the same writes as `HandoverService.openHandover`; the **mock model did not recognise "operator kerak"** as a human request (outcome `ASKED_SLOT`). Whether a real model triggers it is untested.
- Not run: Close button, `/return` command, customer follow-up forwarded under the card while an operator owns the conversation, duplicate delivery of one update, quick consecutive messages, uz-Cyrl/ru/en, voice, real LLM answers, any fact with provenance.
- The web-UI connection flow (ADR 028) was **not** exercised against real Telegram: the tunnel proxy forwards only the environment account's route, and `PUBLIC_BASE_URL` was not set.
- Wrong-token HTTP status of the Bot API remains unverified.

## Incidents
1. First attempt: `setWebhook` failed with "Failed to resolve host" because registration ran the moment the tunnel URL appeared. Fixed by retrying registration (commit 89f636d).
2. After the machine was idle overnight the quick tunnel dropped ("Tunnel not found"); Telegram reported 530 and kept the pending callback. A restart re-registered the webhook; the pending callback was no longer delivered. A later quick tunnel exited right after start over QUIC; `--protocol http2` fixed it.

## Local data created
An Operator row (role OPERATOR, owner's Telegram user id) in the `dev-telegram-test` tenant of the local database; two handovers and their messages. Nothing else.
