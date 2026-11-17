# ADR 073 — Conversation that feels like talking to a person, and an agent that gets better at its own business

Status: proposed on 2026-11-17 after the owner's requests: "mijoz AI agent bilan gaplashganida xuddi inson bilan gaplashgandek bo'lishi kerak" and "AI agentni shunday qurginki, u o'zini o'zi aynan o'sha ishlayotgan yo'nalishda kuchaytirib ketaversin". Builds on D1/D4/D5 (facts only from tools, rendered by code), ADR 013 (guardrail), ADR 041 (conversational turns), ADR 063 (conversation insights, proposed).

## Context (checked in the code on 2026-11-17)
- Many customer-facing sentences are fixed templates: capabilities, frustration, out of scope, no results, offer an operator, options intro, language switched (12 template uses in `agent-turn.ts`), and every turn that needs a detail ends with the pack's fixed slot question (5 uses). A customer who chats gets the same sentence again ("Thanks, all good! Which subject or course are you interested in?" twice in a row on 2026-11-17).
- Small talk is model-worded since the ADR 041 amendment of 2026-11-17, with the guardrail and the template as fallback. That pattern is safe and cheap (one FAST call).
- A Telegram typing indicator exists. Nothing aggregates what customers ask (ADR 063 is not built).

## Decisions
### A. Human-like conversation (no change to how facts are shown)
1. **Model-worded, code-guarded.** Every reply that carries no hard fact is worded by the model for this message (capabilities, frustration, out of scope, no results, language acknowledgements), checked by the same guardrail, with the current template as the fallback. Hard facts stay `{{F<n>}}` references rendered by code (D1, D5): being natural never means inventing a price or a date.
2. **The next question is asked, not pasted.** The code still decides which detail is missing (D4); the model gets that slot's meaning and the pack's question as an example and asks it in its own words, joined to its answer. The same question is never sent verbatim twice in a row; after two unanswered asks the agent offers options or a person instead of asking again.
3. **Acknowledge, then help.** The prompts ask for: short messenger replies, answering what the customer actually said first, the customer's name when known, the customer's formality (siz/sen, вы/ты), no repeated greetings, no "As an AI…" unless asked.
4. **Speed is part of feeling human.** Keep the typing indicator; fetch the live quote of the top offers by code right after search when the customer asks about price or availability (saves a model round; owner approval needed for the extra CRM calls).
5. **Measured.** Eval metrics per locale: replies identical to the previous bot reply (target 0), template share, median latency; a small live LLM-judged "sounds like a person" score on the owner cases. Owner chats become eval cases (as `eval/cases/*/owner-*.json` already are).

### B. An agent that improves at its own business (per tenant)
6. **ADR 063 is the base:** S1 capture what customers ask and where the agent fails (topic, outcome, language; no personal data), S2 a weekly report for OWNER/ADMIN, S3 proposed knowledge (FAQ answers, search synonyms) from repeated questions, S4 faster answers for the most common questions.
7. **[OPEN, owner] How much it may change by itself.** ADR 063 says a person approves every learned answer, because a wrong learned answer would be repeated to every customer. Proposed split: search synonyms and spelling variants (they only help find catalog items; facts still come from the CRM) are applied automatically and can be undone; FAQ answers, prices, policies and prompt changes always need one click of approval from the tenant OWNER/ADMIN.

## Order
A1 (model-worded replies with fallback) and A2 (asked, not pasted questions) first: they change every conversation. Then B S1+S2 (insights and report), then A4 price prefetch (with owner approval), then B S3/S4. Each step ships with eval cases and a live run.

## Not decided here
Tenant-level persona (the assistant's name, emoji use) as tenant settings; voice.
