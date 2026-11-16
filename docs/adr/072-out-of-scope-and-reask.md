# ADR 072: Requests outside the business, and asking a detail again

Status: Accepted (2026-11-16, owner: "the AI assistant must get stronger", with a test-chat screenshot).

## Context
In the owner's test chat (education workspace, uz-Latn) "turkiyaga 2 haftaga" and "sayohat qilmoqchiman" were both answered with the same "Qaysi fan yoki kurs bo'yicha o'qimoqchisiz?". Two causes: (1) a request the business does not serve had no intent, so it fell through to the missing-slot question; (2) the missing-slot question was repeated word for word after an answer that did not give the slot (only an invalid value got the "not understood" prefix). The workspace being on the education pack instead of the travel pack is a configuration matter, not handled here (the platform console sets the pack only when a workspace is created).

## Decision
- **New intent `out_of_scope`** ("asks for a product or service this business clearly does not offer", judged by the pack's `businessRole`, already in the extraction prompt). Code answers it, no facts: the locale's `outOfScope` template, the pack's `capabilities` text, then the next missing question. The turn is `ANSWERED` with asked slot `scope:outside`; a second out-of-scope request right after it gets `outOfScope` + `offerOperator` instead of the same text again (the customer can then ask for a person, which is a handover intent).
- **Slots win over the label:** if the message gave or changed any slot, `out_of_scope` is ignored and the normal flow runs, so a misclassified real request is never refused.
- **Asking again:** when the previous turn asked the same slot and it is still missing (and the message is not a greeting), the question gets the `notUnderstood` prefix and the slot's optional `retryHint` (new pack field, per locale, max 200 characters). Hints say how to answer and never name items, prices or dates, so they cannot read as an offer the catalog may not have. The education `subject` and travel `destination` slots carry hints in all four locales.
- STUCK is unchanged: two earlier no-progress turns on the same slot still hand over.
- Nothing vertical-specific in `core/**` (rule 1): the texts live in the locale packs and the domain packs. The web shows the new intent in words (en, ru, uz-Latn; not native-reviewed).

## Checks
`scope-and-reask-turns.spec.ts` (9 tests): the screenshot case, the second request in a row, a stated slot overriding the label, every locale of both packs, the prompt line, a plain first question, the hinted second question, STUCK still firing, and hints present without digits for every search-required slot. API unit suite, agent and Telegram integration tests, web i18n tests.

## Not verified
How often the live model (`gemini-3.8-flash` on staging) picks `out_of_scope` correctly, especially for short Uzbek messages; this needs a live-eval run before relying on it.
