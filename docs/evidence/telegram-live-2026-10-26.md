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

## Second run: real model (Gemini, SHADOW, test messages only)
Opt-in `TELEGRAM_SESSION_LLM=gemini` in `.env` (read by `telegram-session.sh`): Gemini through its OpenAI-compatible endpoint, `gemini-3.5-flash-lite` for both tiers in the calls made, `LLM_TRUSTED_PROVIDERS=mock` (Gemini is an *untrusted* provider: SHADOW on the test account only, nothing was sent to the customer chat). The text of five test messages went to Google; the README states Gemini's free tier content is "used to improve our products", and the owner's plan was not checked.

| Message (test text) | Turn outcome | Draft (not sent) |
|---|---|---|
| `Salom` + `Kurslaringiz haqida ma'lumot bering` (arrived 7 s apart, handled as one batch; the first turn was discarded as superseded) | HANDOVER, reason STUCK | "Bir-birimizni to'g'ri tushunmayotgandek. Xabaringiz jamoamiz uchun saqlandi." |
| `Narxi qancha?` | ASKED_SLOT | "Qaysi fan yoki kurs bo'yicha o'qimoqchisiz?" |
| `Menga operator kerak` + `Privet, у вас есть курсы на русском?` (4 s apart, one batch) | HANDOVER, reason CUSTOMER_REQUEST (the real model recognised the human request; the mock did not) | "Albatta. Xodim bilan bog'lanish haqidagi so'rovingiz saqlandi." (Uzbek, although the last text was Russian) |

Measured per turn: 1 model call, about 690-730 input and 59-89 output tokens, 2.7-5.1 s; no `LLM_INVALID_REQUEST`, no rate-limit error, no failure code in 5 turns (the 2026-10-23 evaluation had both).

Findings and limits:
- STUCK on a plain greeting is an artefact of the shared test conversation: earlier no-progress turns of the mock runs count toward `STUCK_REPEAT_LIMIT`, with no time window. Worth deciding whether old turns should stop counting.
- In SHADOW the handover outcomes are stored as drafts and **no Handover row or operator card was created** (the only handover in the window is the one opened by the script earlier). Real handovers from the model are therefore still not observed end to end.
- The Russian question was handled in the same batch as the operator request, so Russian replies were not tested on their own; the draft language was Uzbek.
- A greeting got a handover draft and a price question got a clarifying question, not a fact: no price or any other hard fact was shown, so provenance and the guardrail were not exercised. Five messages, one provider, one day: not a quality measurement.

## Third run: Gemini in LIVE (owner declared Gemini trusted for this run only), STUCK fix
`TELEGRAM_SESSION_LLM=gemini-live`: `LLM_TRUSTED_PROVIDERS=openai-compatible` for the session process only, test account switched to LIVE for the run and **back to SHADOW afterwards**; `.env` default restored to the SHADOW-only `gemini` mode. Test messages only.

| Message | Result |
|---|---|
| `Salom` (after the STUCK fix) | Real reply sent: "Assalomu alaykum! … Qaysi fan yoki kurs bo'yicha o'qimoqchisiz?" No STUCK (earlier turns of other days no longer count). |
| `Kurslaringiz haqida ma'lumot bering` | Clarifying question sent. |
| `IELTS kursi qancha turadi?` with no catalog connected | Honest "no data" handover (`NO_DATA`), card delivered; nothing invented. |
| Same question with the fictional mock catalog | 4 model calls, 6.8 s. `search_catalog` (code) and `list_offers` (model-requested) found the item; the draft used the **listed** price, the display gate refused it (`FACT_NOT_LIVE`: a price needs a live confirmed quote from `get_quote`), the single regeneration (no tools available) repeated it, so the turn ended in `GUARDRAIL` handover and the customer got "Hozir bu savolga ishonchli javob bera olmayman. Savolingiz jamoamiz uchun saqlandi." No wrong price was shown. |

Defects found and fixed in this run:
1. STUCK counted turns of any age and across human handovers (commit 7cd1534).
2. Gemini 3 refuses a tool round whose earlier tool calls lack their `thought_signature` (HTTP 400, shown to the customer as a technical-fault notice): the adapter now echoes the vendor `extra_content` (commit 65176a8, reproduced with a direct request and a unit test).
3. `gemini-3.8-flash` (preset STRONG) did not answer within 25-70 s on that day; `gemini-3.6-flash` took 15 s; `gemini-3.5-flash-lite` about 1 s. The session script uses `gemini-3.5-flash-lite` for both tiers. The preset default is unchanged and unverified.

Open (not changed, needs a decision): the model ignored prompt rule 2 ("call get_quote when the customer asks what they will pay") twice, and the regeneration step offers no tools, so a price question ends in a handover whenever the model skips `get_quote`. Options: (a) let the regeneration call tools with a specific hint for `FACT_NOT_LIVE`; (b) make the code fetch the quote itself for a price intent (like `search_catalog`); (c) a stronger model. The Russian question was not answered separately (the conversation was in handover at that time).

## Fourth run: LIVE with Gemini after the fixes, through an ngrok static domain
Tunnel: ngrok free static domain (`TELEGRAM_TUNNEL=ngrok`, authtoken in ngrok's own config); the registration worked on the first try, unlike the Cloudflare quick tunnels (which dropped overnight and failed DNS on most attempts). Gemini declared trusted for this run only, test account LIVE for the run and **back to SHADOW afterwards**; test messages only.

| Message | Result |
|---|---|
| `IELTS kursi qancha turadi?` (an older message that waited at Telegram until the webhook was back) | ANSWERED in 3.5 s, 4 model calls, no guardrail violation, no regeneration, no fallback: `search_catalog` (code), `list_offers`, `get_quote` twice. Reply "IELTS Preparation: 150 US$, 180 US$." plus a question; both prices are live confirmed quotes (F10, F11) rendered by code. The two prices carry no label (which offer each belongs to). |
| `Привет, у вас есть курсы на русском?` | ANSWERED in Russian ("Здравствуйте! … какой именно предмет … интересует?"), 3.5 s. |
| `Menga operator kerak` | HANDOVER `CUSTOMER_REQUEST` recognised by the real model (1 call, 1.1 s); a card was delivered to the operator group (`notificationStatus=SENT`); the customer got "Albatta. Xodim bilan bog'lanish haqidagi so'rovingiz saqlandi." |

What this does and does not show: the price path now works end to end with a real model (earlier failures: Gemini 3 tool signature, retry without tools, digits written by the model; the verified-quote fallback was not needed this time). It is three real turns of one provider on one day, not a quality measurement; the fictional mock catalog was used; Close, `/return`, follow-up forwarding under the card and other languages remain untested live.
