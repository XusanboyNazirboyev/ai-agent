# Cost experiment 2026-11-21: cheaper reply model

Owner request: plan prices five to six times lower than the first proposal, so the cost per lead must fall about that much.

## Measured cost (staging `llm_usage_records`, 2026-11-04..19, owner's test chats)
One bot reply = 2 calls (extract + respond), on average 2,357 input and 91 output tokens. Lead chats averaged 28 replies (3 chats); all chats 8 (median 3.5).

## Prices (https://ai.google.dev/gemini-api/docs/pricing, read 2026-11-20; per 1M tokens)
- `gemini-3.8-flash` (staging today): $0.75 in / $3.75 out until 2026-12-31, then $1.50 / $7.50.
- `gemini-3.5-flash-lite`: $0.30 / $2.50, no announced change. `gemini-3.1-flash-lite`: $0.25 / $1.50. `gemini-2.5-flash`: $0.30 / $2.50.

## Live eval (`scripts/live-eval.ts`, routed, `LLM_REASONING_EFFORT=low`, `eval/live-sample.json`, 27 cases)
| Policy | Pass | Structured valid | Tool calls valid | Slot accuracy | uz-Latn | p50 ms | Cost |
|---|---|---|---|---|---|---|---|
| `gemini-primary` (3.8-flash) | 16/27 | 27/27 | 36/38 | 94.7% | 10/15 | 7233 | $0.086 |
| `gemini-3.5-flash-lite` | 16/27 | 27/27 | 39/39 | 94.7% | 8/15 | 1935 | $0.041 |
| `gemini-3.1-flash-lite` | 8/27 | 3/27 | 2/2 | 42.1% | 4/15 | 1219 | $0.016 |
| `gemini-2.5-flash` | 6/27 | 21/27 | 18/19 | 84.2% | 3/15 | 2389 | $0 (served by free fallbacks) |

One run each; earlier repeats of one policy differed by one case. No hard-fact violation shipped in any run (3.5-flash-lite: 3 drafts blocked by the guardrail, 3.8-flash: 1).

## Result
Per reply at the measured tokens: 3.8-flash $0.00422 (2027) against 3.5-flash-lite $0.00094, 4.5 times cheaper; a lead (about 20 replies including chats without a lead) about 1,010 against 224 so'm (1 USD = 11,971.64 so'm, CBU 2026-11-20). `builtin:gemini-lite` (3.5-flash-lite, free fallbacks only) with pricing `routing-gemini-lite-2026-11-21` is ready; staging still runs `gemini-primary`. Spend of all runs about $0.15.

## Open
uz-Latn passed 8 of 15 against 10 of 15 in one run: repeat on staging traffic before switching for good. Implicit caching (cache reads are 0 on staging) not investigated further.
