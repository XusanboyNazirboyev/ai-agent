# ADR 091 — Unanswered questions become FAQ entries after the owner answers them

Status: built 2026-11-24 in autonomous mode (owner 2026-11-15); item 4 of the competitor gaps ([research](../research/competitors-2026-11-24.md)). Owner review pending.

## Context
- When the bot has no data for a question it hands over (`NO_DATA`). Nothing showed the owner which questions these were, so the same gap stayed open (Salam AI and Chatla turn them into knowledge).
- Knowledge already has FAQ entries the bot retrieves (ADR 027).

## Decisions
1. **An unanswered question** is a committed agent turn with outcome `HANDOVER` and reason `NO_DATA` in the last 14 days; its text is the customer message the turn answered (`messages` at `answered_sequence`; nothing new is stored). The same text (ignoring case and spacing) is one item with a count.
2. **Knowledge → Unanswered** tab: everyone reads; OWNER/ADMIN "Add answer" opens the FAQ dialog with the question filled in, and saving it (the owner's confirmation) creates the FAQ entry and marks the turns `ANSWERED`; "Dismiss" marks them `DISMISSED`. Nothing enters the knowledge base without the owner saving it.
3. Additive migration `20261205090000_knowledge_gaps`: `agent_turns.gap_resolution` (VarChar 16) and `gap_resolved_at`. API `GET /api/v1/knowledge/gaps`, `POST /api/v1/knowledge/gaps/resolve` (tenant-scoped, audited `knowledge.gap_resolved` with the count only).
4. **Morning digest** (operator group, when enabled) gains "Questions the bot could not answer: N (Knowledge → Unanswered)" for the last day, only when N > 0.

## Not done
- Answering from Telegram (reply to the digest): the web keeps the confirmation step simple.
- `NO_RESULTS` (catalog search found nothing) is not listed: the customer got an answer, and an FAQ entry does not add a product.

## Consequences
- The owner closes knowledge gaps in two clicks; the next customer gets the answer from the FAQ.
- If saving the FAQ entry works and marking the question fails, the question stays listed and can be dismissed.
