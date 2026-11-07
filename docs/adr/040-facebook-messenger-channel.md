# ADR 040: Facebook Messenger (Page inbox) as a channel adapter

Status: Accepted (2026-11-07, owner asked for Facebook integration). Slices 1 and 2 are implemented; a live check with a real Page is pending.

## Decision
Messenger is a channel adapter beside Telegram and Instagram (D6); the LLM provider stays separate (D15). What Instagram and Messenger share moved to `apps/api/src/channels/meta/`: webhook signature and GET handshake (`meta-webhook-auth.ts`) and byte-based text splitting (`meta-text.ts`). The Instagram modules re-export them under their old names, so nothing else changed.

Messenger-specific core in `apps/api/src/channels/facebook/`:
- `normalizeFacebookWebhook`: `object: "page"`; `entry[].id` is the Page, `messaging[].sender.id` the Page-scoped user id (PSID). Ignored: echoes (also any event whose sender is the Page), deleted, text-less, and events without `message` (postbacks, receipts). `standby` is never read, so the bot cannot answer a thread another app owns.
- `evaluateFacebookWindow`: a reply only within 24 hours of the customer's last message, measured from our receive time.
- `buildFacebookTextRequests`: `POST /<PAGE_ID>/messages` bodies `{recipient:{id}, messaging_type:"RESPONSE", message:{text}}`, one per part, recipient validated as a numeric id.

## Sources (official Meta pages, read 2026-11-06)
- Webhooks: https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks.md
- Messages event: https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messages
- Send a message: https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
- Rules and limits already recorded in `docs/research/channel-rules.md` (2026-10-25).

## Facts that matter
- Signature: `X-Hub-Signature-256: sha256=<hex>` keyed with the App Secret. Meta signs an escaped-unicode form, so the check runs on the raw received bytes, never on a re-encoded string (tested with an escaped Cyrillic body).
- Reply 200 within 5 seconds; unsubscribed after 1 hour of failures; delivery order is not guaranteed (use `timestamp`); duplicates must be tolerated (dedupe on `mid`).
- Subscribe a Page with `POST /<PAGE_ID>/subscribed_apps` (`subscribed_fields=messages`), needs a Page access token and `pages_messaging` + `pages_manage_metadata`.
- Error 1545041 "Messaging window closed"; 10 permissions, 100 invalid parameter, 190 expired token, 551 person not available, 613 rate limit.

## Not decided / unverified
- The maximum text length is not stated on the send page. The splitter uses the same conservative 1,000 bytes as Instagram.
- The `HUMAN_AGENT` tag (7 days, manual replies): its field name and exact string are not shown on the pages read. Nothing is sent with a tag; operator replies after 24 hours are refused until it is verified.
- `is_echo` is not documented on the messages page; echoes are also recognised by sender equal to the Page.
- The `timestamp` unit is not stated; not relied on.
- Serving other businesses needs Advanced Access (`pages_messaging`, App Review) and Business Verification; the owner has no company documents yet, so only Pages with a role in the Meta app can be tested.

## Next slices
1. Webhook controller and service (raw-body signature, fast 200, queue by `mid`), sender with the window gate and error mapping, `facebook` channel type, mode parity with Telegram and Instagram.
2. Connect flow: Facebook Login, list the user's Pages, store the Page token in the channel secret store, `subscribed_apps`; a web card.

## Slice 2 (2026-11-07): webhook, sender, connect flow
- **Webhook:** `POST /webhooks/facebook` (`object: "page"`), signature on the raw bytes with the Meta app's App Secret (`INSTAGRAM_APP_SECRET`), the same verify token as Instagram (`INSTAGRAM_VERIFY_TOKEN`). Accepted events go through the Instagram intake, now parametrised by channel type (`facebook.inbound` outbox events, the same dedupe on `mid`, per-account rate lock and conversation lock).
- **Send:** the processor's Meta path (`sendMeta`) serves Instagram and Messenger with the same 24-hour window, 1,000-byte parts, "never resend an ambiguous or partial send" rules; Messenger sends `POST graph.facebook.com/v27.0/<PAGE_ID>/messages` with `messaging_type: RESPONSE` and the Page access token. Error codes are prefixed `facebook_`.
- **Connect:** `api/v1/channels/facebook` (`oauth`, `oauth/start`, `oauth/complete`, `:id/enable`, `:id/disable`), OWNER/ADMIN, rate-limited, audited. Facebook Login for Business with `FACEBOOK_LOGIN_CONFIG_ID` and `FACEBOOK_OAUTH_REDIRECT_URI` (web page `/channels/facebook/callback`); code → User token → long-lived token (`fb_exchange_token`; when Meta refuses the extension the first token is used, for a system-user configuration) → `GET /me/accounts?fields=id,name,access_token` → exactly one granted Page (none: `NO_FACEBOOK_PAGE`, several: `SEVERAL_FACEBOOK_PAGES`). The Page token is stored encrypted (`facebook_page_access_token`); the Page starts DISABLED with the assistant OFF; enable calls `POST /<PAGE_ID>/subscribed_apps` (form data, `subscribed_fields=messages`). The OAuth state is the sealed, session-bound state of ADR 031 with its own AAD (`facebook-oauth-state`), spent once in Redis.
- **Web:** Settings → Channels shows Messenger with "Continue with Facebook"; the account card uses the same enable/disable actions as Instagram.
- **Owner steps (Meta App Dashboard):** add the Messenger use case to the same Meta app; create a Facebook Login for Business configuration for Messenger (token type User access token; permissions `pages_messaging`, `pages_manage_metadata`, `pages_show_list`); register `https://<web host>/channels/facebook/callback`; in Webhooks subscribe the **Page** object to `messages` with callback `https://<api host>/webhooks/facebook` and the same verify token.
- **Unverified until a live connect:** the token type the configuration issues; the exact permission names the configuration lists; real Page delivery and send.

