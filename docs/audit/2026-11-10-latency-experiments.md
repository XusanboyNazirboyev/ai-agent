# Reply latency: stage timings and experiments — 2026-11-10

Branch `feat/agent-latency` (from `47d02f0`). Follows the plan in [2026-11-06-performance.md](2026-11-06-performance.md) for the "model-tier routing" and "provider prompt cache" rows.

## Main finding
**The application never sent `LLM_REASONING_EFFORT`.** `llmEnvironment()` (`apps/api/src/agent/llm.factory.ts`) copied every LLM setting from Nest config except `LLM_REASONING_EFFORT`, so the routed provider was built without it and Gemini ran at its default thinking level on every branch (checked `main`, `feat/production-pilot`, `feat/integration-2026-11-07`, `feat/dev-mock-connector`). Only `scripts/live-eval.ts`, which reads `process.env`, used `low` (ADR 041 measured with it). Fixed in `a871d2b` with a unit test that fails without the fix. Staging's extraction p50 of about 3.3 s matches the "no effort" runs below (3.2–3.4 s), not the `low` runs (2.0–2.2 s). This match is evidence, not proof: staging was not inspected.

## Method
- **Stage timings** (new, `core/agent/turn-timings.ts`): `runAgentTurn` returns `timings` = `gatesMs`, `extractMs`, `searchMs`, `respondMs` (with `respondRounds`, `toolExecutions`, `respondToolMs`), `guardrailMs`, `otherMs` and `totalMs`. The stages add up to `totalMs`. They are logged with `latencyMs` in `agent.turn_committed` (telegram pipeline, which persists `AgentTurn`). No DB columns.
- **Runs:** `scripts/live-eval.ts`, `LIVE_EVAL_PROVIDER=routed`, real providers, keys from the local `.env` (never printed), pricing `routing-gemini-paid-2026-11-09`. Fixed sample of 30 live education cases: 15 uz-Latn and 15 ru (8 ANSWERED, 3 ASKED_SLOT, 2 HANDOVER, 1 NO_RESULTS and 1 CLARIFICATION per locale). 17 of the 30 reach the catalog search and the reply model. Turns ran one after another. Output ceiling 1024 per call; the harness asks for 600 (extract) and 900 (respond). The app uses 600 and `LLM_MAX_OUTPUT_TOKENS` (default 1024). Staging's value was not checked.
- live-eval now records per-case timings and per-call model, duration and tokens (`live-<stamp>.outcomes.json`). In routed mode it sends the effort the same way the app does.
- Percentiles are nearest-rank over the turns of one run. Extract is per call. Respond is per turn that drafted a reply (all rounds). Total is all 30 turns, so turns without a model call pull it down.

## Results (30 turns per run; two runs of each main variant)
| Variant | Pass | Extract p50/p95 ms | Respond/turn p50/p95 ms | Total p50/p95 ms | Search turns total p50/p95 ms | Rounds avg (max) | Tokens in/out | Metered cost |
|---|---|---|---|---|---|---|---|---|
| a0 `gemini-primary`, no effort (= staging as deployed) | 16 | 3248 / 4892 | 14242 / 21117 | 14286 / 22508 | 17424 / 25397 | 2.82 (4) | 96234 / 3211 | $0.084 |
| a0 repeat | 15 | 3369 / 5134 | 13131 / 19274 | 14024 / 19703 | 16579 / 22274 | 2.71 (4) | 91935 / 3051 | $0.080 |
| a `gemini-primary`, `low` (baseline as intended) | 22 | 2222 / 3097 | 8952 / 15835 | 6914 / 16613 | 11750 / 18352 | 2.76 (4) | 87634 / 3254 | $0.078 |
| a repeat | 21 | 2053 / 3924 | 11296 / 17135 | 7565 / 17186 | 13086 / 19396 | 2.82 (4) | 89219 / 3373 | $0.080 |
| b `gemini-primary-fast-groq`, `low` | **19** | 1557 / 3354 (stage p95 4404) | 10033 / 15600 | 2749 / 16282 | 11641 / 16980 (n=12) | 2.67 (3) | 73651 / 3171 | $0.049 |
| d `low` + `LLM_FAST_REASONING_EFFORT=minimal` | 2 | HTTP 400 | — | — | — | — | 0 | $0 |
| e `LLM_REASONING_EFFORT=minimal` | 0 calls | HTTP 400 | — | — | — | — | 0 | $0 |

- **Where the time goes:** in every run the model calls are over 99% of `totalMs`. Gates are under 1 ms, the catalog search (MockConnector) about 1 ms, the guardrail at most 27 ms. A reply turn is extraction plus 2.7–2.8 STRONG rounds: price and details questions call `list_offers` and `get_quote` before the final draft, 38–42 tool executions per run.
- **Uzbek final drafts:** with `low`, the ru final draft takes p50 2.3 s. The uz-Latn final draft takes p50 8.4 s, and 6–7 per run stop at `max_tokens` with about 35 visible tokens. The rest is hidden thinking. Those turns end in `FALLBACK`; this is the known pre-existing FALLBACK failure. With no effort, ru drafts do the same (p50 8.7 s, 6 FALLBACK).
- **(b) Groq for extraction:** extraction calls are faster (p50 1.6 s), but Groq served only 12 of 28 extractions. The rest failed over to Gemini after a rate limit. Groq's published Developer-plan base limit for `openai/gpt-oss-20b` is 30 RPM and 8K TPM (https://console.groq.com/docs/rate-limits, read 2026-11-10), and one extraction is about 1.5K tokens. Three of the 12 Groq extractions missed the subject slot (ru-03, ru-07, uz-latn-08 → `ASKED_SLOT`), so the pass count drops. **Rejected.** Groq paid prices, for reference only, from https://console.groq.com/docs/model/openai/gpt-oss-20b (read 2026-11-10): input $0.075, cached input $0.037, output $0.30 per 1M tokens. The catalog keeps the model as free (free plan), and no new pricing version was added.
- **(c) Prompt caching:** `cached_tokens` was 0 on all 361 recorded calls. Implicit caching on `gemini-3.8-flash` needs at least 4,096 prompt tokens (https://aistudio.google.com/docs/caching, read 2026-11-10). The extraction prompt is about 1,500 tokens and a reply call about 1,000–1,400. The static parts are already a stable prefix (fixed system prompt, then fixed tools, then the per-turn user message), so a reorder cannot help and **no change was made**. A probe with an 18.7K-token repeated prefix showed hits on the native API (`cachedContentTokenCount` 16,635) but no `cached_tokens` on the OpenAI-compatible endpoint, and latency was the same (2.7–2.8 s). Prompt size is not where the time goes.
- **(d) Extraction only:** `gemini-3.8-flash` rejects `reasoning_effort=minimal` with HTTP 400 ("Thinking level MINIMAL is not supported for this model"). `low` is therefore the lowest level. A lower `maxOutputTokens.extract` would not help: with `low`, extraction never hit its 600-token ceiling (0 of 84 calls; the 2 truncated extractions were both in the no-effort runs), and its visible output is about 55 tokens. `LLM_FAST_REASONING_EFFORT` stays in the code for models that accept a lower level; unset, nothing changes. **Do not set `minimal` with this model.**

## Cost
Metered across all runs: $0.371 (5 complete runs; d and e cost $0). Probes: about $0.05 (estimated from token counts). **Undercount:** the OpenAI-compatible endpoint leaves thinking tokens out of `completion_tokens`. For example, a probe returned `completion_tokens` 0 with `total_tokens` − `prompt_tokens` = 45, while the native API reported `thoughtsTokenCount` 45. The adapter (`usageOf`) therefore meters no thinking tokens. The 42 `max_tokens` drafts alone hid about 40K output tokens (about $0.16). Estimated real spend is under $1 of the $3 cap. Budget reservations still use the capped worst case, so the spending limits remain upper bounds.

## Recommendation for staging (not applied)
1. Deploy a build with `a871d2b` and `11c33e7`, and keep the existing setting `LLM_REASONING_EFFORT=low`. No env change is needed if it is already set as described. Otherwise add exactly `LLM_REASONING_EFFORT=low`. Keep `LLM_ROUTING_POLICY_FILE=builtin:gemini-primary`, and leave `LLM_FAST_REASONING_EFFORT` unset. Expected from these runs: extraction p50 3.3 → 2.1 s, total p50 14 → 7 s, search-turn p50 17 → 12–13 s, pass count 15–16 → 21–22 of 30. Check after deploy with `timings` in `agent.turn_committed`.
2. Do not use `gemini-primary-fast-groq`.
3. The next levers, all unmeasured: (i) the uz-Latn final draft's hidden thinking hitting the ceiling (8–9 s, then FALLBACK). Options are measuring a higher respond ceiling, or a prompt fix. (ii) Tool rounds: price questions take 3 STRONG rounds, so a code-driven live quote (D10) could remove one or two rounds. (iii) Meter Gemini thinking from `total_tokens`.

## Not measured / not verified
- No staging traffic or logs were read. The cause of staging's 6–8 s is inferred from matching numbers.
- No concurrency, no cold vs warm comparison, no queue wait, and no Telegram send. Single runs of 30 turns with small samples: ±1–2 passes is noise (repeat runs differed by 1).
- en, uz-Cyrl and the travel pack were not run, and neither was the full regression (98+ cases).
- Groq's free-plan limits for this key were not read from the console. Mistral and OpenRouter fallbacks were not exercised.
- Respond ceiling 900 in the harness vs `LLM_MAX_OUTPUT_TOKENS` in the app (staging value unknown).
