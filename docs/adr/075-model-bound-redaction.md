# ADR 075 — Card and identity numbers never reach the language model

Status: accepted (owner decision 2026-11-18: "ha, hammaga avtomatik yashir", for every tenant). Follows the ChatLab research (item 1; ideas only, no ChatLab code: AGPL-3.0).

## Context
- Every customer text that goes to a model passes `sanitize()` in `core/agent/prompts.ts` (extraction, reply, conversational replies, assistant suggestions, test chat, voice transcripts via `voice/voice-turn-engine.ts`).
- Until now it only escaped `<`/`>` and cut to 2 000 characters: a card or passport number a customer typed went to the LLM provider as is. `redactPii` existed only for turn records and summaries.

## Decision
- `redactForModel` (`core/agent/redaction.ts`) runs inside `sanitize()`, for every tenant, with no setting: card numbers (16 to 19 digits together, four groups of four with one separator, or 13 to 15 digits that pass Luhn and do not start with 0) become `[card]`; an Uzbek passport or ID card number (two Latin capitals and seven digits) becomes `[document]`; a PINFL (14 digits starting with 3 to 6) becomes `[id]`.
- Phones are kept (leads need them); prices, dates and short codes are untouched by construction (tests list them).
- Only the copy sent to the model changes. The stored message, the inbox, operator notifications, the CRM and the guardrail's view of the customer's own words are unchanged.
- The prompts tell the model that the marks stand for hidden numbers and that it must not ask for them again or repeat the mark.

## Not covered
- Audio sent to speech-to-text is not redacted (the transcript is, before the agent's model sees it).
- A Russian internal passport (ten digits, like a phone) and numbers written in words are not detected; detecting them needs keywords per language (a Locale Pack field) and was not built.
- Tenant-defined extra rules (ChatLab's per-user rule list idea) are not built.

## Checked
- `src/agent/model-redaction.spec.ts`: card spellings, passport/ID/PINFL, a list of phones/prices/dates/codes left unchanged, `sanitize`, and a full turn whose recorded model requests contain neither number; mutation (sanitize without redaction) fails 2 tests. API unit suite passes except the known local-only live-eval key test. Live on Gemini, owner cases o01 to o15 pass ($0.03).
