# ADR 092 — Answering from the owner's own Telegram account (Telegram Business)

Status: **Accepted** 2026-11-25 (owner chose Q1 (b), the platform bot). Item 5 of the competitor gaps ([research](../research/competitors-2026-11-24.md)).

## Facts (official docs, read 2026-11-25)
- https://core.telegram.org/bots/features.md (Business Bots): the bot enables **Secretary Mode** in @BotFather; the account owner connects it and picks which chats it may access. The bot receives `business_connection` (established, edited, ended), `business_message`, `edited_business_message` and `deleted_business_messages`; it sends with `business_connection_id` in `sendMessage`, `sendChatAction` and other send methods. Connected users see a "Manage Bot" bar that opens the bot with `/start bizChat<user_chat_id>`.
- https://core.telegram.org/bots/api/types/businessconnection.md: `id`, `user`, `user_chat_id`, `date`, `rights`, `is_enabled`. https://core.telegram.org/bots/api/types/businessbotrights.md: `can_reply` = may send and edit in private chats **that had incoming messages in the last 24 hours**.
- https://core.telegram.org/api/business: "connected business bots are also available to non-Premium users". **No Premium needed** (closes the ADR 026 "re-verify Premium" condition).
- https://telegram.org/tos/bot-developers §5.4: state truthfully what the bot does; say what private data is kept, how long and why; use the data only for this service; **never disclose message contents to third parties, including third-party APIs, without the user's authorization** (our LLM provider is one); never hide activity from the owner; notify owners of significant changes. Violations can ban the bot and account.

## Proposed design
1. Webhook `allowed_updates` gains `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages` (today `message`, `callback_query`).
2. A `business_connection` is stored on the channel account (connection id, owner Telegram user id, `can_reply`, `is_enabled`; no message text). Ended or disabled: the bot stops answering business chats at once.
3. A business chat is its own conversation: `provider_chat_id = "b:<chat_id>"`, so it never merges with the same customer's chat with the bot itself (both have the same `chat.id`). Replies go through `sendMessage` with `business_connection_id`, only when `can_reply` and the customer wrote within 24 hours (the existing window check, with Telegram's rule).
4. A `business_message` **from the owner** (sender = connection user) is the owner answering by hand: stored as an operator message, and the conversation goes to OPERATOR_ACTIVE, the same as the Instagram/Messenger echo (ADR 088), with the idle return giving it back.
5. Connecting needs the owner's explicit consent in our UI (ToS §5.4 iv): "customer messages in the chats you choose are processed by tezda and its AI provider to answer them; kept N days". The consent is audited. Without it, business updates are stored as "not processed" and never sent to the model.
6. Agent mode, schedule (ADR 089), budget and guardrails apply unchanged.

## Open questions for the owner
- **Q1 (answered 2026-11-25: (b) the platform bot): which bot does the owner connect?** (a) The tenant's own bot, already connected on the Channels page: the owner enables Secretary Mode for it in @BotFather (one more step for them; routing is simple: the webhook already names the tenant). (b) The platform bot (@tezdaaaAI_bot): no BotFather step; we map the connecting Telegram user to the tenant through a signed deep link sent from the web first. Recommendation: (a) now, because it needs no new routing, and (b) later for owners without a bot.
- Q2: how long business chat text is kept (default: the tenant's retention setting).

## Decision (2026-11-25, owner chose Q1 (b))
The owner connects the platform bot (@tezdaaaAI_bot); no BotFather step for them. This replaces points 1 to 4 above where they differ:
1. Only the platform bot's webhook gains the business update types; tenant bots keep `message`, `callback_query`.
2. Linking (also the ToS §5.4 consent): on the Channels page an OWNER/ADMIN ticks the consent box and gets a link `t.me/<platform bot>?start=biz<code>`. The code is an HMAC of the tenant id with a 10-minute expiry (same scheme as the ADR 036 group link, its own key). Opening it records the owner's Telegram user id as a channel account `telegram` / `business:<telegram user id>` (DISABLED), audited with the consent. One Telegram user belongs to one tenant at a time; a later link from another tenant is refused.
3. The `business_connection` update from that user stores its id on the account (`business_connection_id`, unique) and sets ACTIVE when `is_enabled` and `rights.can_reply`, else DISABLED. A connection from a user with no link is ignored (logged by id only); the platform bot tells them to start from the Channels page.
4. A `business_message` is routed by `business_connection_id` to that account and enters the ordinary Telegram path (same normalizer, `accept`, queue, agent pipeline). It is a separate channel account, so the chat never merges with a bot chat that has the same id (the Message docs say so too).
5. Sends for such an account use the platform bot token and add `business_connection_id` (sendMessage, sendChatAction, sendVoice all take it).
6. A message in the business chat from the owner (sender = connection user) without `sender_business_bot` and not `is_from_offline` (away/greeting messages) is the owner answering: recorded as an operator message and the bot steps back, as in ADR 088.
7. Safety on business accounts: agent mode OFF sends nothing (no Phase 2 echo), and follow-ups are not sent (the 24-hour `can_reply` window).

## Built (2026-11-25)
- `channels/telegram/telegram-business.ts` (parsing, link code, account key) and `telegram-business.service.ts` (link, connection, message routing), called first by the platform webhook; signup gets everything else.
- Migration `20261206090000_telegram_business`: `channel_accounts.business_connection_id` (unique, additive).
- Sends: `TelegramCredentials.targetFor` gives the platform token and the connection id; `TelegramSender` (sendMessage, sendVoice) and `TelegramBotApi` (sendChatAction and the rest) add `business_connection_id`.
- The tenant's Telegram management routes (enable, test, disconnect, operator group) refuse a business account (404), so the platform bot's webhook can never be changed from a tenant's page.
- Activation respects the plan's channel limit (ADR 047); when it is full the bot tells the owner.
- Web: Channels page "Connect my Telegram account" with the consent box (`POST /api/v1/channels/telegram-business/link`, audited `channel.telegram_business_consent`); a business account card says it is managed in Telegram.
- Ops after deploy: re-run `pnpm ops:platform-bot-webhook --url <api>` so the platform webhook asks for the business update types.
- Known limits: the link code names the tenant, not a Telegram user, so a forwarded link links whoever opens it (they must still add the bot in their own Telegram Business); consent is recorded when the link is issued.
- Not done: handover notices for a business account (it has no operator group; the Inbox and the bell still show them), disconnecting from our side (the owner removes the bot in Telegram, which turns the account off).

## Not verified
- A live business connection; the exact Telegram menu names ("Telegram Business → Chatbots") used in the bot's and page's instructions; whether Telegram delivers `business_message` for the owner's own outgoing messages in every client (the docs describe `business_message` for the managed chats; the sender check covers both cases); that every message the bot sends comes back with `sender_business_bot` (documented on Message; a reply already committed is also recognised by its stored message id).
