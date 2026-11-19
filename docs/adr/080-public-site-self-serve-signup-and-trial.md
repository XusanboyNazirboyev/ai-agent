# ADR 080 — Public sales site, self-serve signup with Telegram, 3-day trial

Status: accepted (2026-11-19). Supersedes ADR 047 §7 "Self-serve signup" (out of scope then). Owner request 2026-11-19, items 5 and 6:
- "Make the website a selling website. Three plans: Basic handles 500 contacts, Premium 1000 leads, All included is negotiated for enterprises. Whoever wants to use it can try a 3-day free demo. Connect Payme or Click."
- "Even if we do not install the assistant for them, anyone who comes to it must be able to set it up and run it themselves; make it so simple that anyone can use it."

## Owner decisions (2026-11-19, answered in the session)
1. **Plan limit unit:** new leads per month (calendar month in the tenant's time zone), counted from the leads created that month. Over the limit the owner and admins are warned; nothing is blocked yet.
2. **Trial:** 3 days, **no card** at signup. When it ends without payment the subscription expires and the existing rule applies: the assistant stops answering, messages are still stored and operators still see them (`inbound-access-gate.ts`, ADR 047 §3).
3. **No automatic charging.** The customer pays each period themselves with a pay button (checkout of the payment provider). Card storage and recurring charges are not built.
4. **Signup is confirmed through Telegram:** the new owner opens the tezda platform bot from the signup page, presses Start and shares their phone number; there is no e-mail provider yet (no domain).
- **Open:** which provider takes the payments (Payme or Click; both need a merchant contract, a cash register id and a key from the owner). The pay button is built after that answer; until then payments are recorded by hand in the console as today.
- **Prices** are not decided in code: the owner enters them per plan in the console (ADR 047 §2), and the public page shows what the console holds.

## Decision
### Plans on the public page
- `subscription_plans` gains `is_public` (default false) and `position` (additive migration); `limits.monthlyNewLeads` joins the optional limit keys. The console plan form edits all three.
- `GET /api/v1/public/plans` (no session, rate limited, cached 60 s): active public plans in `position` order with name, price (minor units + currency, rendered by code), period, and the public limit keys only.
- "All included" for enterprises is not a plan row: the page shows a fixed card with "price by agreement" and a contact button (a Telegram link the owner sets in the environment, `PUBLIC_SALES_CONTACT_URL`; hidden when unset).

### Public site
- `/` shows the sales page to a visitor without a session; a signed-in person still goes to `/today`. Sections: what tezda does (answers customers in Telegram and Instagram in their language, takes leads into a funnel, hands over to a person, reminds about tasks), how to start in three steps, plans, questions and answers, footer with the privacy, terms and data deletion pages. uz-Latn, ru, en like the app (D22); phone layout first.
- Every plan button and the hero button lead to `/signup` with the plan code.

### Self-serve signup
1. `/signup`: business name, your name, e-mail (it is the login), password, chosen plan. `POST /api/v1/public/signups` validates, rate limits by IP, stores a pending signup (hashed one-time token, 30 minutes, password already hashed with the existing scrypt helper) and returns a link `https://t.me/<platform bot>?start=<token>`.
2. The platform bot (a new Telegram bot owned by tezda, token in the server's secrets, webhook with its own secret path like the tenant bots) answers `/start <token>` by asking for the phone number with Telegram's contact button. A contact whose `user_id` is the sender's own id confirms the signup.
3. Confirmation creates, in one transaction: the tenant (`config.billing.required = true`), the OWNER operator with the stored password hash, a `TRIAL` subscription on the chosen plan for 3 days, and a platform audit event. One trial per Telegram user and per phone number; a repeat is refused with a message pointing to sign in.
4. The signup page waits for the confirmation (polling its pending signup id) and then signs the browser in and opens the setup guide.
- Stored about the person: name, e-mail, phone, Telegram user id. Nothing else from Telegram is kept.

### Setup a non-technical owner can finish alone
The Today page's getting-started list (ADR UX step 2) becomes a guided setup after signup, one step per screen with plain words and a picture where it helps: 1) kind of business (choose a ready template), 2) connect the Telegram bot (create it in BotFather, paste the token; existing connect flow), 3) give the assistant knowledge (price list from Excel, CSV or a Google Sheets link; a short description and answers to common questions), 4) try it in the test chat, 5) turn the assistant on. Every step can be skipped and finished later from Today.

### Lead limit warnings
A daily scan counts each tenant's new leads this month against `monthlyNewLeads`; at 80 % and at 100 % the OWNER and ADMIN see a banner and the tenant's Telegram operator group gets one message per threshold per month (same sender as the subscription reminders). The console customer page shows the count against the limit.

## Not done
Automatic charging, the payment provider's pay button (waits for the provider choice and the merchant contract), e-mail verification, invoices, blocking over the lead limit, a custom domain.

## Owner steps before it can be used
Create the platform bot in BotFather and give its token to the server's secret store (never in chat); set `PUBLIC_SALES_CONTACT_URL`; enter plan prices in the console and mark the plans public; choose Payme or Click and sign the merchant contract.

## Implementation notes (public site and plans)
- Migration `20261129090000_plan_public_listing`: `subscription_plans.is_public` (default false) and `position` (default 0). The table is a platform table without `tenant_id` and without RLS (as created in `20261115090000`), so nothing else changed. `limits.monthlyNewLeads` (positive integer) is validated in `platform-plans.controller.ts` and read by `planLimitsOf`.
- `GET /api/v1/public/plans` lives in `src/public/` (not `src/platform/`; it only reads `subscription_plans`). Rate limit: the sign-in limiter (60 requests a minute per client address, same address rules). Cached 60 s in memory per process. Besides `plans` it returns `contactUrl` from the server variable `PUBLIC_SALES_CONTACT_URL` (https only); the web falls back to `NEXT_PUBLIC_SALES_CONTACT_URL`. The button is hidden when neither is set. Public limit keys: `monthlyNewLeads`, `maxOperators`, `maxChannelAccounts`; `priceMinor` is a string.
- Public page: `/` renders the site for everyone and the browser asks `GET /api/v1/auth/me`; on success it goes to `/today` (a signed-in person may see the page for a moment). All sales strings are in one `site.*` block of the catalogs.
- Lead limit warnings: `LeadLimitScanService` (a `ScheduledScan`, runs at most every 6 hours per process; finds open subscriptions whose plan sets `monthlyNewLeads`, counts each tenant's leads created in the current calendar month of the tenant time zone, archived included). The marker is the outbox idempotency key `alert:new-leads:<tenant>:<YYYY-MM>:<80|100>` of an `alert.operator` event (kind `LEAD_LIMIT`), so no new table; if the count jumps over both thresholds only 100 is sent. The text is in `operator-text.ts` (en, ru, uz-Latn). `GET /me` gains `leadLimit: { newLeadsThisMonth, monthlyNewLeads } | null` for OWNER and ADMIN only; the web shows a banner from 80 %. The console customer page shows the count against the limit. Nothing is blocked.
- Not verified: no browser run of the page at 320 px (layout uses a single column, `overflow-x-hidden`, no fixed widths); Uzbek and Russian wording needs a native read.

## Implementation notes (signup and setup)
Built 2026-11-19 on `feat/self-serve-signup`.
- Migration `20261129090000_self_serve_signup`: `pending_signups` (SHA-256 of the one-time token and of a browser binding secret, e-mail lowercased, scrypt password hash, plan id, status PENDING/CONFIRMED/EXPIRED/REFUSED, Telegram user id and chat id, phone, created tenant id, refusal reason, last update id, signed-in time, 30-minute expiry) and `trial_claims` (unique Telegram user id, unique phone; kept after a tenant is deleted so deletion does not hand out a new trial). Both are platform tables: no `tenant_id`, no RLS, touched only on the privileged connection (`signup/signup.service.ts` is on the privileged-database allow list).
- Code lives in `apps/api/src/signup/` (not under `src/platform/`, which only `app.module.ts` may import). `POST /api/v1/public/signups` (Origin checked against `WEB_ORIGINS`, per-IP limiter like login, same password policy as invites, 409 `EMAIL_TAKEN`, 400 `PLAN_INVALID` for an unknown, inactive or non-public plan, 503 `SIGNUP_UNAVAILABLE` when the platform bot env is missing) sets an httpOnly binding cookie. `GET /api/v1/public/signups/:id` returns the status only; for the browser holding the binding cookie it signs in once (`SessionService.openSession`, same cookies as login) and answers `signedIn: true`; a second call or another browser gets `signedIn: false`.
- Platform bot webhook `POST /webhooks/platform-telegram/:pathSecret`: the path secret is derived from `PLATFORM_TELEGRAM_WEBHOOK_SECRET` (HMAC), the `X-Telegram-Bot-Api-Secret-Token` header must equal that secret; both compared in constant time, 403 otherwise. `/start <token>` asks for the phone with a reply keyboard button `request_contact`; a contact whose `user_id` is the sender's id confirms. One transaction creates the tenant (slug from the business name, `config.billing.required = true`, `config.selfSignup = true`, first registered Domain Pack, default locale from the Telegram `language_code`, time zone Asia/Tashkent as a default the owner can change), the OWNER operator with the stored hash, a 3-day TRIAL subscription, the trial claim and the audit event `tenant.self_signup`. Refused with a message in uz/ru/en: foreign contact, expired or unknown token, second trial for the same Telegram user or phone, taken e-mail. Updates are idempotent on `update_id` (per signup). The platform bot never creates channel accounts, conversations or leads (tested). Replies go through `PlatformBotSender` (fetch, 8 s timeout, token only in the URL, never logged). `ops:platform-bot-webhook --url https://<api host>` calls setWebhook.
- Web: `/signup` (form, then "Confirm in Telegram" with a button and 2-second polling until the 30 minutes pass, then `/today?welcome=1`). The plan comes from `?plan=`; without it the first public plan is used; without any, `basic`. No QR code (no QR library in `apps/web`). Login has a "Create an account" link. Today shows `SetupGuide` (5 cards: business kind, connect Telegram, prices or knowledge, test chat, switch on) for `?welcome=1` or a workspace with `config.selfSignup`; done states come from `GET /api/v1/today` (new `checklist.selfSignup`), "skipped" and "templates opened" live in this browser's local storage. Step 1 opens Settings, CRM (ready templates, ADR 067); the BotFather steps are written in the card and connecting uses the existing Channels page.
- Telegram Bot API facts used (https://core.telegram.org/bots/api, read 2026-11-19): `KeyboardButton.request_contact`; `Contact.phone_number` and optional `user_id`; `setWebhook` `url`, `secret_token` (echoed in `X-Telegram-Bot-Api-Secret-Token`); `ReplyKeyboardRemove`. Start parameter limits (A-Z a-z 0-9 _ -, up to 64 characters): https://core.telegram.org/bots/features#deep-linking (read 2026-11-19). The token is 43 characters.
- Tests: unit `signup-rules.spec.ts`; integration `signup.integration.spec.ts` (real database, fake Telegram on a local port; also in `vitest.rls-strict.config.mts`); web `signup.test.ts`, `setup-guide.test.ts`, `signup-page.test.tsx`.
- Not done / not verified: no run against the real Telegram (the bot does not exist yet); no browser or phone-width check of `/signup` and the guide; expired pending rows are not purged (they only expire by status); the first registered Domain Pack is used for every self-signup tenant until the owner chooses another; the guide's "skip" is per device.

### Owner steps for signup
1. Create the platform bot in BotFather (a normal bot; no group privacy settings needed).
2. Put `PLATFORM_TELEGRAM_BOT_TOKEN`, `PLATFORM_TELEGRAM_BOT_USERNAME` (without `@`) and `PLATFORM_TELEGRAM_WEBHOOK_SECRET` (16 to 256 characters of A-Z a-z 0-9 _ -) into the server's secret store. Never in chat or the repository. Without all three the signup answers 503.
3. After deploying run `pnpm ops:platform-bot-webhook --url https://<public API host>` (or `node dist/signup/set-platform-webhook.cli.js --url ...`) once.
4. Mark at least one plan public in the console (the signup accepts active public plans only).
