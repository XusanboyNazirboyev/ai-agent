# Reviewer checklist (per locale)

Reviewers must be native speakers of the locale (for `uz-Latn` and `uz-Cyrl`: Uzbek readers of that script). Mark each item for every quoted line in `REVIEW_PACKAGE.md`; note corrections inline. Nothing here was reviewed yet.

1. **Naturalness** — would a customer write or hear this? Not translated-sounding?
2. **Grammar and spelling** — correct for the language; for Uzbek, correct letters of the script (`oʻ gʻ` / `ў қ ғ ҳ`) and apostrophes.
3. **Politeness and register** — formal "siz/сиз/вы/you", warm, never pushy; consistent across lines.
4. **Clarity** — one idea, short enough for a messenger, no ambiguity about what to do next.
5. **Script correctness** — Latin text stays Latin, Cyrillic stays Cyrillic; only product names may differ. No mixed-script words.
6. **Cultural suitability** — greetings, forms of address, currency/date style, nothing offensive or too casual.
7. **Honesty of safe wording** — no promise of a reply, response time, discount, guarantee or availability; handover lines say only that the message was recorded.
8. **Question wording** — each slot question asks exactly one thing and is answerable in a few words.
9. **Language-request phrases** — natural ways to ask for a reply language; list missing ones; flag phrases that could occur in an ordinary request (false positives).
10. **Forbidden-claim stems** — add stems for discounts, free extras, guarantees that are missing; flag stems that would block innocent words.

## Promotion rule (unchanged)

A locale becomes `stable` only after: this review is signed off by a native speaker, the evaluation threshold for that locale is met on **live** model runs (not scripted tests), and `nativeReviewed` is set in the pack by a reviewed change. Passing automated tests never promotes a locale.
