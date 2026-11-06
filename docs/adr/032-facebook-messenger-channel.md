# ADR 032: Facebook Messenger (Page inbox) as a channel adapter

Status: Proposed (2026-11-06). Slice 1 (pure core) is implemented; webhook, sender and connect flow are not.

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
