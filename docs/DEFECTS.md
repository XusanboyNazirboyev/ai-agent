# Known defects

Record only. Nothing here is fixed by the entry that records it. Status values: OPEN, FIXED (with commit), WONTFIX (with reason).

Found during the Telegram live runs of 2026-10-26 (`docs/evidence/telegram-live-2026-10-26.md`).

## D-001 Prices in the price reply carry no label
- Status: OPEN
- Seen: live run 4 (Gemini LIVE). The verified-quote reply (`b6c7991`) renders the amounts from the validated quote, but the prices in the reply are not labelled (the reply does not say what each amount is).
- Impact: a customer can misread which amount applies. Not a guardrail failure: the numbers come from the validated quote.
- Where to look: `apps/api/src/core/agent/verified-answer.ts`, `prompts.ts`. Labels must come from the locale pack, not from core.

## D-002 `/return` and Close not tested against real Telegram
- Status: OPEN (untested, not known broken)
- Live runs exercised take-over and operator reply by button. "Return to bot" and "Close" were covered only by the integration spec `5b6cf15` (simulated callback updates) and a DB reset script, never by a real button press.
- Needed: one live check per button, in SHADOW mode first, with the owner's approval of the conditions.

## D-003 Stored instants read 5 hours off in plain SQL
- Status: OPEN, cause not established
- Seen: dev machine session time zone is Asia/Tashkent (UTC+5). Prisma round-trips timestamps correctly, but a plain SQL read of the same row shows an instant 5 hours earlier than the UTC time the application meant.
- Checked: every `DateTime` in `apps/api/prisma/schema.prisma` is `@db.Timestamptz(6)` (99 of 99) and the migrations create `TIMESTAMPTZ` (99 definitions, no plain `TIMESTAMP(3)`). So this is not a `timestamp` vs `timestamptz` column mix-up.
- Hypothesis (unverified): `@prisma/adapter-pg` sends JS Dates as offset-less strings, which the server then interprets in the session time zone. Writes and reads agree with each other, so the application looks right while SQL, exports and other clients see shifted values.
- Workaround in tests: `analytics.integration.spec.ts` seeds with explicit-offset literals (`$1::timestamptz`) and computes bounds in SQL.
- To verify: write one row from the app under two different session time zones and compare `created_at AT TIME ZONE 'UTC'`.

## D-004 Three BullMQ integration tests fail while the dev API is running
- Status: OPEN (isolation issue)
- A running dev API consumes jobs from the same Redis queues, so the three queue integration tests lose jobs to it. They pass with the dev servers off.
- Fix direction (not done): test-specific queue names or Redis DB/prefix per run.
