# ADR 017: Uzbek orthography folding (legacy Latin, updated Latin, Cyrillic)

- **Status:** Accepted
- **Date:** 2026-10-24

## Context
Customers write Uzbek in Cyrillic, in the legacy Latin alphabet (`oʻ gʻ sh ch`, tutuq/apostrophe) and, increasingly, in an updated Latin alphabet with `Ğ ğ, Ö ö, Ş ş, Ç ç` (the alphabet supplied for this project; its official status was not verified here). Detection, slot matching and catalog search must treat these as one language without rewriting anything that is stored or shown.

## Decision
- **Canonical internal form = legacy Latin.** `updatedLatnToLegacy` maps `ğ ö ş ç` to `g' o' sh ch` (case-aware, `ŞAHAR` -> `SHAHAR`). It is one-way and idempotent; the reverse (`sh` -> `ş`) is never applied because `s`+`h` can be two letters. `normalizeForMatching` = apostrophe unification, updated->legacy, Cyrillic->Latin, lower case: one key for `Oʻzbekcha`, `Özbekcha` and `Ўзбекча`. More apostrophe lookalikes (`′ ʹ ˈ`) are unified.
- **Originals are preserved.** Folding is applied to copies for detection, enum-slot matching, reply-language request phrases and one extra catalog query. Slot values keep the customer's spelling; connector data is never rewritten. When a title search returns nothing, the same search is repeated once with the title in canonical spelling (`searchByOrthographicVariant`, only if it differs; a normal metered tool call).
- **Four separate concepts:** detected language, script, orthographic style (`cyrillic`, `latin-legacy`, `latin-updated`, `latin-mixed`, `latin-neutral`, `none`; descriptive, never evidence) and requested reply language (ADR 015). Replies stay in the legacy-Latin pack: there is no reviewed updated-orthography reply pack.
- **Detector:** after folding, `ğ ö ş ç` are the same weak evidence as `o'`/`g'` (capped, never classifying without a recognised word). A message typed entirely in capitals is text, not acronyms (previously `SALOM, NARXI QANCHA?` was unclassifiable).

## Not verified
Native-speaker validation, accuracy on real text, and the official status of the updated alphabet. All locales stay `beta`. Turkish, Azerbaijani and German text containing `ö ş ç ğ` is not recognised as Uzbek without Uzbek words.
