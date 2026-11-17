# ADR 073 — Conversation that feels like talking to a person, and an agent that gets better at its own business

Status: A1 and A2 built on 2026-11-17 (the rest proposed); proposed on 2026-11-17 after the owner's requests: "mijoz AI agent bilan gaplashganida xuddi inson bilan gaplashgandek bo'lishi kerak" and "AI agentni shunday qurginki, u o'zini o'zi aynan o'sha ishlayotgan yo'nalishda kuchaytirib ketaversin". Builds on D1/D4/D5 (facts only from tools, rendered by code), ADR 013 (guardrail), ADR 041 (conversational turns), ADR 063 (conversation insights, proposed).

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
7. **How much it may change by itself (owner decision 2026-11-17: "ha roziman").** Search synonyms and spelling variants ("aylts" → IELTS; they only help find catalog items, facts still come from the CRM) are learned and applied automatically and can be undone by the tenant. FAQ answers, prices, policies and prompt changes always need one click of approval from the tenant OWNER/ADMIN, because a wrong learned answer would be repeated to every customer.
   - Checked 2026-11-17: the extraction model already maps "aylts kursi bormi?" to IELTS and finds the course (live, eval `edu-uz-latn-o04`). Learned variants matter for tenant-specific names the model cannot know.

## Built (2026-11-17)
- A1/A2 for small talk, "what can you do", mild frustration and out-of-scope requests: `conversationalReply` in `agent-turn.ts` asks the FAST model (`conversationalSystemPrompt`) to answer this message and ask the code-chosen next question in its own words; the slot bookkeeping is unchanged. The draft passes the guardrail; a refused draft, a model failure, or a draft identical to the previous bot message falls back to the template. Small talk gets no canned line to convey (it was copied back as "Thanks, all good").
- Checked: `conversational-turns.spec.ts` (worded reply asks the question itself, a fact in the draft falls back, a verbatim repeat of the last bot message falls back); live on gemini-3.8-flash all conversational, out-of-scope and owner cases 16/16, 31 calls, $0.029.
- Not yet: catalog answers and slot questions after a search still use the response prompt's own wording rules; "never the same question twice" for those turns; insights (B).

## Amendment (2026-11-17, later): the owner's test chat, second round
- **Seen in the test chat:** "qanaqa kurslar bor" and "kurslar haqida malumot ber, markazda nechta kurs bor" got the "what I can do" text twice (the extraction model read them as `capabilities`; the Uzbek example "qanaqa xizmatlar bor?" pulled them there); "matem kursi bormi" (no such course) went straight to a person; "qaysi tillarni bilasan" and "nemis tilida yozsam javob berasanmi" got the capabilities text.
- **Built:**
  - New intent `catalog_overview` ("which items are there, a list, how many, what kinds"): the code lists up to 8 catalog titles (title facts rendered by code, guardrail as for the option list) after the locale's `catalogIntro`, then asks the next missing question. A message that names an item (a title slot) searches as before; other details it gives (e.g. "markazda" read as a format) are kept and do not stop the list. Same language check as before facts.
  - New intent `language_question`: answered from the locale's new `languagesSpoken` line (Uzbek Latin and Cyrillic, Russian, English; other languages not supported), worded by the model with that line as the only source, the template as fallback.
  - `capabilities` is now described as the general "what can you do / who are you", explicitly not a list of items or languages; both new intents have per-locale examples that are not eval texts.
  - **Nothing found:** the first time the reply says so, lists what the catalog has, asks the title question again and offers a person, without a hand-over (`NO_RESULTS`, asked slot `search:no_results`); a second empty search in a row, or a catalog that cannot be listed, hands over with `NO_DATA` as before. The eight `empty_results` eval cases now expect the real catalog in the reply and no hand-over.
- **Checked:** unit tests (`catalog-overview-turns.spec.ts`: list, named item, first and second empty search, languages fallback, every locale's lines, extraction prompt); scripted eval 396/396; live on Gemini (`builtin:gemini-primary`, reasoning low) the owner cases o01 to o09, 9/9, 13 calls, $0.017 (the live report keeps pass/fail per criterion, not the reply text).

## Amendment (2026-11-17, third round): switching language mid-chat
- **Seen:** "ruschada yozib ber", "rus tilida javob ber", "shuni rus tilida bo'lsin", "inglizcha gapr", "endi english tilida gapr" were not read as language requests (informal verbs, a typo, "english tilida"), and got the languages answer; a detected switch only said "now I write in Russian" even when the message asked for the courses.
- **Built:** request detection knows "yozib ber", "yozgin", "gapr", "gapirgin", "gaplashgin", "tarjima qil(ing)", "english tilida", "englishcha", and the phrases "<language> tilida javob ber" / "<language> tilida bo'lsin" (as phrases only: "inglizcha kurs bormi, javob bering" stays a question about a course). A switch whose intent asks for something (list, details, price, availability, booking, capabilities) is answered in the new language (a list when no item is known); a switch right after a catalog list lists it again in the new language; a bare request, or one whose item name came from the request's own words ("ingliz tilida gaplash" read as an English item), is acknowledged as before. `language_question` no longer covers requests to write in a language.
- **Checked:** unit tests (request detection for all five texts, list in Russian, repeat after a list, bare request); scripted eval 400/400; live on Gemini the owner cases o01 to o13, all pass ($0.028 in total for these runs).
- **Open:** a model-read request (any spelling) as a fallback to the word lists; requests are still re-derived from history by the word lists.

## Order
A1 (model-worded replies with fallback) and A2 (asked, not pasted questions) first: they change every conversation. Then B S1+S2 (insights and report), then A4 price prefetch (with owner approval), then B S3/S4. Each step ships with eval cases and a live run.

## Not decided here
Tenant-level persona (the assistant's name, emoji use) as tenant settings; voice.
