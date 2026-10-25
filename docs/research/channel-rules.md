# Messaging channel rules and adapter design input (Stage 0, D2)

Read 2026-10-25 from official docs only. Facts not confirmed on an official page are marked *unverified*. Meta moved its docs under `https://developers.facebook.com/documentation/` (abbreviated **D/** below); the older `/docs/` paths still resolve. Re-verify before each channel slice; the rules change often.

## Market relevance (Uzbekistan)
Telegram is the primary channel, at about 76% of the internet audience by a secondary source ([UzDaily](https://www.uzdaily.uz/en/telegram-76-reach-youtube-no-1-e-commerce-on-the-rise-inside-uzbekistans-digital-landscape/), *unverified*). Instagram comes second, with about 15.3M ad-reachable users in Dec 2025 ([NapoleonCat](https://napoleoncat.com/stats/social-media-users-in-uzbekistan/2025), *unverified*). WhatsApp and Messenger matter less locally; VK and Viber are marginal (*unverified*). Viber self-service bot creation has reportedly been closed since 2024 (third party, *unverified*).

## Per-channel facts

### Telegram Bot API (current 10.3, 2026-08-24)
| Topic | Rule | Source |
|---|---|---|
| Prerequisites | BotFather bot token. No review. **Business mode:** the owner connects the bot in Settings › Telegram Business › Chatbots and chooses chats. One business bot per account. Bot API 10.0 (2026-05-08) says no Premium is needed, the 2024 blog says Premium is needed: **re-verify** | [api](https://core.telegram.org/bots/api), [connected business bots](https://core.telegram.org/api/bots/connected-business-bots), [changelog](https://core.telegram.org/bots/api-changelog) |
| Webhook auth | `secret_token` sent in `X-Telegram-Bot-Api-Secret-Token` (1–256 characters) | [setWebhook](https://core.telegram.org/bots/api#setwebhook) |
| Retries / dedupe | Retried a "reasonable" number of times. `update_id` is sequential but may reset after a week idle: dedupe by update_id + message_id. Unfetched updates are kept for 24h | [getting updates](https://core.telegram.org/bots/api#getting-updates) |
| Windows | None, but **bots cannot message first**; the user must start | [bots](https://core.telegram.org/bots) |
| Rate limits | About 1 msg/s per chat, 20/min per group, about 30/s bulk; handle 429 `retry_after` | [FAQ](https://core.telegram.org/bots/faq) |
| Types | Text 4,096 characters. Inline and reply keyboards (reply keyboards are not allowed in business messages). `callback_data` ≤ 64 bytes. Media groups of 2–10. Reactions. `sendChatAction` lasts ≤ 5s. Mini Apps. Download ≤ 20 MB, upload ≤ 50 MB | [api](https://core.telegram.org/bots/api), [features](https://core.telegram.org/bots/features) |
| Entry context | Deep link `/start <payload>`, ≤ 64 characters `[A-Za-z0-9_-]` (use opaque IDs for ad attribution) | [deep linking](https://core.telegram.org/bots/features#deep-linking) |
| Business updates | `business_connection`, `business_message`, `edited_/deleted_business_messages`; send with `business_connection_id`; check `rights.can_reply` | [api](https://core.telegram.org/bots/api) |

### Instagram Direct (Instagram API with Instagram Login or Facebook Login)
| Topic | Rule | Source |
|---|---|---|
| Prerequisites | Professional account. `instagram_business_basic` + `instagram_business_manage_messages`. Serving other businesses needs **Advanced Access = App Review + Business Verification**. Lead time is *unverified* | D/instagram-platform/overview |
| Webhook auth | GET `hub.challenge`/`hub.verify_token`. POST `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret) | D/instagram-platform/webhooks/setup |
| Retries / dedupe | Retried over 36h, then dropped. Dedupe is our job (key `mid` is *inferred*). Batches of up to 1,000 | same |
| Windows | 24h from the user's last message. Up to 7 days after a Click-to-Direct ad (changelog 2026-09-28). `HUMAN_AGENT` tag gives 7 days for **human-written** replies only. No other tags, no one-time notifications | D/instagram-platform/overview, D/business-messaging/instagram-messaging/changelog, D/business-messaging/messenger-platform/policy |
| Rate limits | Send API 300/s text and 10/s media (one page says 100/s: **conflict**). Private replies 750/h for posts | D/business-messaging/messenger-platform/overview (rate limiting) |
| Types | Text ≤ 1,000 bytes. Images (8 MB, ≤ 10). Audio/video/file 25 MB. Quick replies ≤ 13 × 20 characters. Generic template 10 cards × 3 buttons. Button template 1–3. Ice breakers ≤ 4. Reactions, typing, seen. No groups | D/instagram-platform/instagram-api-with-instagram-login/messaging-api |
| Entry context | Story reply (`reply_to.story`). Story mention (`story_mention` attachment). **Private reply to a comment: one message per commenter within 7 days**, and the window opens only when the user answers. Ad referral (`ref`, `ad_id`, `ads_context_data`). `ig.me?ref=` up to 2,083 characters | …/private-replies, webhooks/examples, …/ig-me |
| Thread ownership | Handover Protocol ended 2025-10-23 and was replaced by **Conversation Routing**. Meta Business AI may own a thread, so the bot must not send on standby | instagram-messaging/changelog, messenger-platform/conversation-routing |

### Facebook Messenger
| Topic | Rule | Source |
|---|---|---|
| Prerequisites | Page plus an app with the Messenger use case. `pages_messaging`, `pages_manage_metadata` and related permissions. Advanced Access needs App Review, and Business Verification is needed for non-role users. Lead time is *unverified* | D/business-messaging/messenger-platform/overview |
| Webhooks | Same handshake and signature. **Reply 200 within 5s.** Unsubscribed after 1h of failures. Order not guaranteed: sort by timestamp | D/…/messenger-platform/webhooks |
| Windows | 24h (7 days after a Click-to-Messenger ad). `HUMAN_AGENT` 7 days for manual replies. Several update tags return error 100 since 2026-04-27. Marketing Messages only for reviewed tech providers, opted-in users, and not in the EU, Japan, Korea, Australia or the UK | D/…/send-messages, D/…/marketing-messages-on-messenger |
| Limits | 300/s text, 10/s media per Page. Daily cap 200 × engaged users. Error 613 on rate limit | D/…/overview (rate limiting) |
| Policy | Automated bots must answer within 30s. Disclose automation where the law requires it. Conversation Routing (pass/take thread control) | D/…/policy, D/…/conversation-routing |

### WhatsApp Business Platform (Cloud API)
| Topic | Rule | Source |
|---|---|---|
| Prerequisites | Business portfolio, WABA, phone number. Display-name review is automatic (no timeframe given). Business verification raises limits (lead time *unverified*). **Multi-tenant SaaS = Tech Provider + Embedded Signup v4** (v2/v3 deprecated 2026-10-15) with **advanced access via App Review**. 10 new customers per 7 days, or 200 after verification | [get started](https://developers.facebook.com/docs/whatsapp/business-management-api/get-started), [embedded signup](https://developers.facebook.com/docs/whatsapp/embedded-signup/overview) |
| Webhooks | `hub.challenge` handshake. `X-Hub-Signature-256` over the raw body. Retries for up to **7 days**. Duplicates are possible; dedupe on `wamid` | [webhook endpoint](https://developers.facebook.com/docs/whatsapp/webhooks/create-webhook-endpoint) |
| Windows | 24h customer-service window, reset by each user message. Outside it, **templates only**. Free-entry-point window up to 7 days after Click-to-WhatsApp ads (a 72h figure elsewhere is outdated) | [send messages](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages), D/business-messaging/whatsapp/pricing |
| Templates and pricing | Marketing, utility and authentication categories, review ≤ 24h. 250 templates unverified, 6,000 verified. Per-message pricing since 2025-07-01. **From 2026-10-01, service messages over 1,000/month/number and utility messages inside the window are charged. Opt-in required** | D/…/whatsapp/templates/overview, …/pricing |
| Limits | 250 → 2k → 10k → 100k → unlimited unique users per 24h. 80 msg/s, up to 1,000. Error 130429 | [messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits) |
| Types | Text, media, location, contacts, reaction. Reply buttons ≤ 3 × 20 characters. Lists ≤ 10 rows. CTA URL, Flows. Typing indicator ≤ 25s. CTWA `referral` (schema only partly verified) | send-messages, D/…/interactive-* |
| **Policy risk (unverified)** | A ban on "AI Providers" whose primary functionality is AI (§4.7). The Stage 0 researcher reported it from a Russian-language version of the terms page linked here. The owner notes the reading traces to a **secondary source (respond.io blog)**, and the press dates a general-purpose-AI chatbot restriction to 2026-01-15. **Status: unverified.** It must be confirmed against Meta's official terms text, or in writing from Meta or a BSP, before any WhatsApp work (decision 4). Verified: automation must offer prompt escalation to a human, and platform data must not be used to train models | [WhatsApp Business Platform terms](https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform), [policy](https://whatsappbusiness.com/policy/) |

## Design consequences (input to ADR 026 §D)
1. **One `ChannelAdapter` contract.** Covers `verify(request)`, `parse(raw) → CanonicalInbound[]`, `capabilities()`, `render(CanonicalOutbound, capabilities) → provider payloads`, `send()` with typed errors (`RATE_LIMITED{retryAfter}`, `WINDOW_CLOSED`, `NOT_THREAD_OWNER`, `PERMANENT`) and `dedupeKey()`. The core never sees provider payloads.
2. **Canonical message model.** Inbound: `text | media(kind, ref) | button_reply(payload) | reaction | story_reply | story_mention | comment(postRef) | referral(source, ref, adId) | business_connection_change`. Outbound: `text | quick_replies | buttons | carousel | media | typing | mark_seen`. Each outbound carries a degradation rule (buttons become a numbered text list, carousel becomes N messages).
3. **Conversation policy state per channel.** Tracks `windowExpiresAt`, `windowKind` (`standard | ad_referral | human_agent`), `threadOwner`, `optedIn/optedOut`. A send gate in code: bot sends are refused outside the window; `HUMAN_AGENT` only for operator-written text; WhatsApp outside the window only via approved templates.
4. **Splitting and limits from capabilities.** 4,096 characters (Telegram), 1,000 bytes (IG), 640 (button text). Per-chat throttle (Telegram ≈ 1/s) and per-account rates in config.
5. **Security and idempotency.** HMAC over the raw body (Meta) or secret header (Telegram). Fast 200 then queue (Messenger needs < 5s). Dedupe keys `update_id+message_id`, `mid`, `wamid`. Order by provider timestamp per conversation.
6. **Accounts.** Multiple channel accounts per tenant, tokens via `secretRef` only, with refresh and expiry tracking. Telegram Business adds one account per connected business user, keyed by `business_connection_id`.

## Cross-channel identity
A `Contact` stays per channel identity. A new `Person` links contacts, and links are **only** created on strong evidence:
- the same verified phone number (WhatsApp `wa_id` or a phone shared by the customer), or
- an operator merge, or
- a customer-confirmed link code.

Never merge on name. Merges are reversible and audited. Consent and opt-out are stored per channel identity, and opt-out is honoured across linked identities. The operator inbox shows one person with channel tabs.

## External prerequisites checklist for the owner
Start these now, in parallel with design. Lead times are *unverified* unless stated; Meta publishes no SLA for business verification or App Review.

| # | Item | Needed for | Owner action | Expected wait |
|---|---|---|---|---|
| 1 | Telegram production bot (BotFather) + domain with HTTPS for the webhook | Telegram live | Create bot, choose name, keep token in the secret store | Same day |
| 2 | Decide whether to support **Telegram Business** connected-bot mode; check the Premium requirement on a test account | Telegram for SMBs that answer from a personal/business account | Test with one SMB owner account | Days |
| 3 | **Meta Business portfolio + Business Verification** (legal entity documents, domain, phone) | Instagram, Messenger, WhatsApp beyond own accounts | **Started by the owner (2026-10-25)** | Days to weeks (*unverified*) |
| 4 | Meta developer app with Instagram + Messenger use cases; see [App Review prerequisites](#meta-app-review-prerequisites) | **App Review → Advanced Access** for `instagram_business_manage_messages`, `pages_messaging` | Prepare now; **submit only when the Instagram adapter demo works** (decision 4) | Weeks (*unverified*) |
| 5 | Instagram professional account(s) of the pilot tenant | Instagram slice | Pilot tenant converts account | Same day |
| 6 | WhatsApp: confirm the §4.7 "AI Providers" reading against Meta's official text, or in writing from Meta or a BSP; then Tech Provider + Embedded Signup v4; WABA + number per tenant | WhatsApp (slice C3, last) | Written confirmation first | Weeks (*unverified*) |
| 7 | Consent texts and privacy notice per locale (also ADR 022 D-5) | All channels, actions | Owner/legal | — |
| 8 | Disclosure-of-automation wording per locale | Messenger policy, general trust | Owner approves wording | — |

## Meta App Review prerequisites
Checked 2026-10-25 against official Meta pages. Items not confirmed are marked *unverified*. Confirm each item in the App Dashboard before submitting. Per owner decision 4, **submit only once the Instagram adapter demo works end to end.**

**App settings (before submission)**
- [ ] Privacy policy URL; app icon 1024×1024 (no Meta trademarks); category; primary contact email; app purpose "Clients". See the [submission guide](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide.md).
- [ ] Data deletion request URL (or callback), next to the deauthorize callback URL ([Instagram create-app](https://developers.facebook.com/docs/instagram-platform/create-an-instagram-app/), [Pages create-app](https://developers.facebook.com/documentation/pages-api/create-an-app)). For the Instagram messaging permissions it is listed in setup, not shown as an explicit review gate.
- [ ] Terms of service URL and app domains (*unverified* as review requirements; prepare them anyway).
- [ ] **Verified business connected to the app.** Business Verification is needed for Advanced Access ([IG overview](https://developers.facebook.com/documentation/instagram-platform/overview)). We serve other businesses, so we are a Tech Provider ([Pages create-app](https://developers.facebook.com/documentation/pages-api/create-an-app)).
- [ ] Messenger: the linked Facebook Page is published, and the webhook answers 200 within 20 s ([Messenger app review](https://developers.facebook.com/documentation/business-messaging/messenger-platform/app-review)).

**Per permission**, see [permissions reference](https://developers.facebook.com/documentation/development/permissions):
- [ ] Its own usage description (no copy-paste between permissions) and **≥ 1 successful API call within 30 days before submitting**.
- [ ] `instagram_business_manage_messages`: describe the messaging features for onboarded businesses. Screencast: full Instagram login, the app sending a message to an Instagram user, and a cURL send.
- [ ] `instagram_business_basic`: concrete reason. Screencast: login, then username and ID retrieval.
- [ ] Facebook-Login variant `instagram_manage_messages`, if used: needs `instagram_basic`, `pages_read_engagement`, `pages_show_list`.
- [ ] `pages_messaging` (needs `pages_manage_metadata`, `pages_show_list`). Screencast: Facebook login, a message sent to a Messenger user, a cURL request.
- [ ] Screencasts: ≥ 1080p, English UI or captions, no audio, the full flow from logged-out through permission grant (including Page selection), annotated ([screen recordings](https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings/)). One clip per permission is *unverified*.
- [ ] Reviewer access: public app or step-by-step instructions, test credentials or a trigger phrase; never personal developer credentials.

**Data handling and verification**
- [ ] Data-handling questions after business verification; Access Verification for some permissions (submission guide).
- [ ] Annual Data Use Checkup (*unverified*; mentioned only in the permissions reference).

**Documented rejection reasons**, from [app review](https://developers.facebook.com/docs/resp-plat-initiatives/app-review/):
- the reviewer cannot access the app
- a permission has no recording, or the use shown is not an allowed use
- the login flow is incomplete
- no test credentials, or steps that cannot be reproduced
- non-English UI without captions

Changing settings after submission can trigger re-review.

**Timing:** Meta states "within a week", often 2–3 days ([introduction](https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction)). Business Verification time is not stated (*unverified*).

**Our demo must show:**
1. Instagram login and account connection in our web app.
2. An inbound DM appearing in the inbox.
3. The agent (or an operator) replying.
4. The reply arriving in the Instagram app.
5. Data deletion working.

This needs slice C1, the privacy policy and the data-deletion endpoint first.
