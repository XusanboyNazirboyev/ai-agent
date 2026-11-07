# ADR 041: Conversational turns, gentler frustration handling and a narrower STUCK rule

- **Status:** Accepted, 2026-11-07 (owner decisions in chat).
- **Context:** On staging (Instagram, uz-Latn, 2026-11-07) a customer wrote "salom", "nma gap", "qanday yordam beraolasan?" and "qandaysiga tusshunmaslik mumkin yordam sozini?". The bot asked "Qaysi fan yoki kurs…?" twice with the same text, then handed over with `STUCK` (spec §7.4, "question repeated twice without progress"), then with `COMPLAINT`. The agent had no intent for "what can you do", small talk or annoyance at the bot, so these went to `other`/`complaint`, and a talking customer counted as "no progress". The tenant also has no knowledge documents yet.

## Decision (owner, 2026-11-07)
1. **Capabilities:** a new intent `capabilities` ("what can you help with", "who are you") is answered by code with the domain pack's `capabilities[locale]` text (no facts; generic locale text when the pack has none), followed by the next missing question. Outcome `ANSWERED`.
2. **Small talk:** a new intent `small_talk` ("how are you", "what is up") gets the locale's short `smallTalk` answer plus the next missing question (or `anythingElse`). Outcome `ANSWERED`.
3. **Frustration:** a new intent `frustration` (annoyed that the bot did not understand) is answered once with the locale's `frustration` text (apology, will ask differently, how to reach a person) plus the next question; the turn stores `askedSlot = "apology:frustration"`. A second frustration right after it hands over (`COMPLAINT`). `complaint` is narrowed to complaints about the business (service, money, quality, broken promise) and still hands over at once (D11 unchanged for real complaints).
4. **STUCK:** `SAME_QUESTION_REPEATED` no longer fires when the current intent shows the customer is engaging (greeting, search, details, price, availability, booking_interest, ai_question, capabilities, small_talk). `SAME_MESSAGE_REPEATED` (the customer repeating the same text) still hands over.
5. **Extraction examples:** locale packs carry `intentExamples` for the four confusable intents; the extraction prompt lists them for the pack's locales. They are not the eval texts.
6. **Live eval parity:** `scripts/live-eval.ts` passes `LLM_REASONING_EFFORT` to the openai-compatible provider, so the evaluation runs the production thinking level.

## Evidence (real model, synthetic data)
- Gemini `gemini-3.8-flash`, `reasoning_effort=low` (staging settings): direct extraction probe, 3 runs each, with the staging history: "qanday yordam beraolasan?" and "siz kimsiz o'zi?" → `capabilities` 3/3; "nma gap" → `small_talk` 3/3; the frustration message → `frustration` 3/3.
- Live eval, 9 new cases (uz-Latn 51–55, ru 20–21, en 20–21): 7/9 before the examples, 9/9 after the examples with the production thinking level; about $0.03 in total.
- The full education regression is recorded in PROGRESS with its result.
- Small samples: these numbers show the fix works on the observed messages; they are not a quality claim for all phrasings.

## Consequences
- Wording added in ru, uz-Latn and uz-Cyrl is not native-reviewed (D18).
- A pack without `capabilities` uses the generic locale text; packs should add one.
- Answers still contain no facts; capability texts must stay free of prices, dates and numbers (tested).
