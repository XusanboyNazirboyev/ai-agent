# ADR 016: Language detector evidence rules and bounded live evaluation

- **Status:** Accepted
- **Date:** 2026-10-25

## Context
After Phase 4 the lexical detector rated random text such as `xqzv wkrt` as Uzbek Latin with high confidence, because each `q` added points for Uzbek. A letter is not evidence of a language, and the language gate trusted the resulting score.

## Decision
- **Two kinds of evidence.** Recognised words from the language word lists are *lexical* evidence. Marker letters (`q`, `oʻ`/`gʻ`, `ў қ ғ ҳ`, `ы щ`) are *weak* evidence: at most one point each with small caps, and a guess with no recognised word of the top language is capped at confidence 0.25, below every threshold in `LanguagePolicy` (MEDIUM 0.30, HIGH 0.40/0.45). Marker letters alone therefore classify nothing.
- **Contradiction is visible.** A recognised word of a second language caps confidence at 0.40, below the beta HIGH threshold (0.45): mixed-language text never reaches HIGH. Latin/Cyrillic mixtures were already excluded from HIGH.
- **Single letters are ignored** as words (`a`, `i`, `у`). Very short messages stay ambiguous (LOW/UNRECOGNIZED), which is the intended behavior: the gate then relies on earlier evidence or model corroboration, or asks.
- **Vocabulary** gained a few frequent Uzbek words (`mening`, `bugun`, `soat`, ... and their Cyrillic forms). The lists stay small, so genuine Uzbek Cyrillic with only marker letters, such as `Мен ўқимоқчиман`, is LOW and takes the clarification path. This trades recall for safety on purpose.
- **Reply-language requests** remain a separate fact ([ADR 015](015-explicit-language-request-and-phase4-completion.md)); a request never proves the message was understood.
- **No new model call.** Corroboration still reuses the extraction call that `MeteredLlm` already meters.

## What is verified and what is not
- Verified (unit tests, `language-detection.spec.ts` and the eval cases): the rules above on fixtures: meaningless strings, isolated `q`, very short messages, genuine Uzbek Latin/Cyrillic, Russian, English, apostrophe variants, a typo, mixed-language text, and the gate with unreadable text.
- Heuristic and **not** verified empirically: every word list, every threshold, the score itself (not a probability), recall on real customer text, behavior on transliterated or slang text. Accuracy has not been measured on real data; no such data is available.

## Bounded live evaluation
`scripts/live-eval.ts` gained `LIVE_EVAL_PROVIDER=routed` (the application's router: only candidates with a set key variable and a priced model; nothing trusted), `LIVE_EVAL_SAMPLE` (a fixed list of fictional case ids, `eval/live-sample.json`), and hard bounds checked before each case: cases, recorded model calls (with a per-case call limit), runtime, and a per-call output ceiling of at most 200 tokens. The cap on USD spend is now at most 1.00. Results are in `docs/PROGRESS.md` and the generated report; they describe one small sample on one date.
