# ADR 089 — When the AI agent answers: always, only outside working hours, or only during them

Status: built 2026-11-24 in autonomous mode (owner 2026-11-15); item 2 of the competitor gaps ([research](../research/competitors-2026-11-24.md)). Owner review pending, especially decision 3.

## Context
- Many sellers want the bot only at night and on days off, and to answer themselves during the day (Salam AI offers this). Some want the opposite.
- The business profile's `hours` is free text for the bot to quote; code cannot read it, so the schedule needs its own structured setting.

## Decisions
1. **Setting** `tenant.config.botSchedule = { mode, days, from, to }`: `mode` is `always` (default; also for anything unreadable), `off_hours` or `work_hours`; `days` are ISO weekdays on which the working window starts; `from`/`to` are `HH:MM` in the tenant's time zone; `from` after `to` runs past midnight into the next day. API `GET/PUT /api/v1/business-profile/schedule` (PUT OWNER/ADMIN, audited `tenant.bot_schedule.updated`); card "When the AI agent answers" on the AI agent Rules page.
2. **Off duty = HOLD.** In the agent pipeline, after the mode check, a batch outside the bot's hours is closed without calling the model or replying (the existing HOLD path); log `agent.off_schedule`. The conversation stays `BOT_ACTIVE` and appears in the Inbox for the team. OFF and SHADOW are unchanged by the schedule only in that OFF returns earlier; SHADOW is held like LIVE.
3. **No late replay.** When the bot's hours begin, it does not go back to messages that arrived while it was off duty; it answers the next customer message. Reason: a reply hours later to a question the team may already have handled is worse than none. Alternative for the owner to choose later: answer the last unanswered message if it is younger than N minutes.
4. Not covered by the schedule: Instagram comment replies, follow-ups (off by default, with their own quiet-hours rule), operator notifications.

## Consequences
- A seller can run the bot only at night and weekends with three clicks.
- In `work_hours` mode nobody answers at night unless the team does; the UI says so.
- Not verified: the card in Safari/Firefox (`<input type="time">` rendering) and native review of the new uz/ru wording.
