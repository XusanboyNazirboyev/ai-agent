# ADR 063 — Learning what customers want: conversation insights, reviewed FAQ suggestions, faster answers

Status: proposed on 2026-11-14 after the owner's request ("the agent should have its own knowledge, learn from chats and facts what customers mostly want, and answer faster"). Not built. Builds on ADR 026 (customer memory, narrowed), ADR 019/027 (knowledge, FAQ), ADR 041 (conversational turns), D1/D2/D5.

## Context (checked in the code on 2026-11-14)
The agent classifies an intent every turn and fills slots, but nothing aggregates what customers ask across conversations. The Analytics page shows counts only. ADR 026 designed per-customer memory and a rolling summary; neither exists in code. ADR 026 rejected a semantic answer cache because prices and availability are live facts. Reply latency is p50 5 s to 10 s (measured in P5).

## Decisions
1. **Learning means insights for humans, never self-written answers.** The system measures what customers ask and where the agent fails, and proposes knowledge; a person approves it. The agent never edits its own facts, prompts or knowledge unreviewed (a wrong answer would otherwise be learned and repeated). Hard facts stay tool-only (D1, D5).
2. **Per tenant only.** No cross-tenant aggregation, no shared model, no data leaving the tenant. Personal data is not stored in insights: a topic key is the pack intent plus a normalised, PII-redacted query, and counts.
3. **S1 capture:** per answered or handed-over turn, one row in `conversation_insights` (tenant, day, intent, topic key, language, outcome `ANSWERED | HANDOVER:<reason> | NO_DATA`, knowledge hit yes/no). No message text beyond the redacted topic key; the same retention as conversations (ADR 049).
4. **S2 report:** a page for OWNER and ADMIN: top topics this week, the share that ended in handover, topics with no knowledge hit, by language and channel.
5. **S3 suggestions:** for topics that miss the knowledge base often, propose a FAQ draft (question text from the redacted topic, the answer left blank or drafted from the tenant's own documents, marked as a draft). The operator edits and publishes it through the existing FAQ flow (regulated flag included). The suggestion list shows how many customers asked.
6. **S4 speed (independent of S1 to S3):** a code-driven catalog search before the model call (saves a model round; owner-approved in P4/P5), cache of embeddings and intent classification for repeated normalised queries, parallel extract and search, prompt-cache-friendly ordering. Prices, availability and dates are never cached as answers: they are re-checked live (D10). Target p50 at most 8 s, measured with the existing latency harness before and after.
7. **S5 customer memory (ADR 026 slice 2):** typed entries (`preference`, `interest`, `constraint`), consent flag, 90-day TTL, deletable (ADR 049/052 erasure covers them). Not used with real customers before the legal review.

## Out of scope
Fine-tuning (D3), cross-tenant learning, automatic publication of suggestions, learning from operator replies without review.

## Open questions for the owner
1. May the redacted topic key be kept for the conversation retention period, or longer for trends?
2. Should operators see raw customer questions in the report, or only the redacted topics?
3. S4 first (speed) or S1 to S3 first (insights)? Recommendation: S1 first (it also measures S4), S4 in parallel by the harness.

## Risks
Redaction misses a phone number or name in a topic key: mitigated by reusing the existing PII policy and a test with planted PII. Operators approve suggestions blindly: the report shows the evidence count and the draft is marked unverified until published.
