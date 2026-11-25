# ADR 092 — Answering from the owner's own Telegram account (Telegram Business)

Status: **Proposed** 2026-11-25 (docs only, nothing built). Item 5 of the competitor gaps ([research](../research/competitors-2026-11-24.md)). Blocked on owner decision Q1.

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
- **Q1 (blocks the build): which bot does the owner connect?** (a) The tenant's own bot, already connected on the Channels page: the owner enables Secretary Mode for it in @BotFather (one more step for them; routing is simple: the webhook already names the tenant). (b) The platform bot (@tezdaaaAI_bot): no BotFather step; we map the connecting Telegram user to the tenant through a signed deep link sent from the web first. Recommendation: (a) now, because it needs no new routing, and (b) later for owners without a bot.
- Q2: how long business chat text is kept (default: the tenant's retention setting).

## Not verified
- A live business connection; whether Telegram delivers `business_message` for the owner's own outgoing messages in every client (the docs describe `business_message` for the managed chats; the sender check covers both cases).
