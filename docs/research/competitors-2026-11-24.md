# Competitor scan (owner request 2026-11-24)

Sources read 2026-11-24 with Tavily extract (landing pages only; claims are the
competitors' own, not verified):
- Sendly: https://www.sendly.uz
- Reveo: https://reveo.uz
- Chatla: https://chatla.uz/uz (chatla.ai is a "launching soon" page)
- Salam AI: https://salamai.uz, https://salamai.uz/imkoniyatlar, https://salamai.uz/narxlar
- Not competitors: https://businessai.uz (a web studio: sites, CRM/ERP, apps, "AI agents"
  as a service), https://salam.ai (an AI consulting studio, not a product).

## What each sells

| | Sendly | Reveo | Chatla | Salam AI |
|---|---|---|---|---|
| Channels | Instagram, Telegram | Telegram, Instagram, WhatsApp | Instagram (comments, Direct, Story replies), Telegram | Instagram Direct + comments, Telegram bot, **Telegram Business** (owner's own account) |
| Pricing | PRO 447 000, BUSINESS 1 300 000, VIP 2 497 000 so'm/month; 3-day trial, 750 credits | not public (225+ companies claimed) | Pro from 14-day trial; Payme/Click per period, 10-25% off for 3/6/12 months; comment→Direct free forever | **pay per answer** from a balance (10 000 so'm trial), choice of Gemini model, low-balance alert in Telegram |
| Stand-out | comment→Direct triggers and flows; "AI Office" (marketer, designer); website chat widget paid per resolved chat | **call scoring** by the client's script, daily morning report; a **wearable badge** recording shop-floor talks (needs, budget, objections, top-5 objections) | collects Q&A from **old Instagram chats**; never invents (low confidence → Inbox + Telegram alert); control from **ChatGPT/Claude** (drafts only) | **product photos** sent by the bot; reads **images and shared posts**; **unknown questions** asked to the owner once a day, answer is remembered; **learns from the manager's replies** (owner confirms); **bot stops when the owner writes** and returns after ~15 min; **work schedule** (only off-hours etc.); silent-customer nudge; orders to a Telegram group, amoCRM/Bitrix24, Excel/Sheets; tone presets; MCP for Claude |

## tezda already has
Telegram bot, Instagram Direct, Instagram comment replies with the one private
reply (comment → Direct, opt-in with trigger words), Messenger, voice notes in
and voice replies out, uz/ru/en with script, handover with Telegram group and
web inbox, CRM funnel with AI staging and scoring, tasks and reminders, Telegram
follow-ups (off by default), operator idle return, knowledge base and price list
(Google Sheets link), Bitrix24/amoCRM sync, quick replies, test chat, analytics,
owner rules, business profile and go-live gate, OnlinePBX connect (call analysis
not built), CSV export, Payme billing.

## Gaps worth closing (ranked by value for Uzbek SMBs / effort)
1. **Bot steps back when the owner answers from the Instagram/Messenger app**
   (echo messages), back after a quiet period. Trust; small. Salam has it.
2. **Work schedule**: always / only outside working hours / only inside. Small. Salam.
3. **Instagram Story replies** handled as Direct with the story as context. Small. Chatla.
4. **Unanswered questions to the owner** (a daily Telegram digest; the owner's
   answer becomes a knowledge entry after confirmation). Medium. Salam, Chatla.
5. **Telegram Business**: answer from the owner's personal Telegram account
   (many Uzbek sellers sell from their own account). Medium-large; Bot API
   business connections, to verify in official docs. Salam.
6. **Photos**: send product photos from the catalog; understand a customer's
   photo or shared post. Medium-large. Salam, Chatla.
7. **Daily morning report** in Telegram (chats, leads, unanswered, handovers). Small-medium. Reveo.
8. **Call scoring** (ADR 085 step 3) by the owner's script criteria. Large. Reveo.
9. Later / owner decision: website chat widget (Sendly), WhatsApp (Reveo),
   pay-per-answer pricing (Salam), live demo chat on the sales page (Sendly).
