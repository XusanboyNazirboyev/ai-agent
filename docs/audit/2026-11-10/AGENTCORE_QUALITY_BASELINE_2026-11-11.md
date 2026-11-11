# Answer-quality baseline on staging — 2026-11-11 (audit P0.5)

Read-only queries on the staging database (`agent_turns`, `llm_usage_records`), last 7 days, build `8dd5de0` deployed 2026-11-10 ~13:00 UTC. Counts only; no message content was read.

## Outcomes (62 turns)
| Locale | ANSWERED | ASKED_SLOT | HANDOVER | FALLBACK | NO_RESULTS | CLARIFICATION |
|---|---|---|---|---|---|---|
| uz-Latn (49) | 9 | 6 | 15 | 8 | 7 | 4 |
| en (9) | 2 | 3 | 3 | 0 | 1 | 0 |
| ru (1) | 1 | 0 | 0 | 0 | 0 | 0 |
(+1 turn without locale.) Handover 19/62 = 31%; FALLBACK 8/62 = 13%, **all Uzbek**.

## Handover reasons (19)
CUSTOMER_REQUEST 5 and COMPLAINT 2 are legitimate. Fixable: **VOICE_UNREADABLE 4** (Instagram voice bug, fixed in `e295143` on 2026-11-10 and verified with a real message), **LLM_UNAVAILABLE 3** (2 × `TURN_TIMEOUT` on 2026-11-09 06:35–06:37, 60 s turn limit, before the reasoning-effort fix; 1 × `LLM_INVALID_REQUEST` on 2026-11-04), NO_DATA 2, LOW_LANG_CONFIDENCE 1, STUCK 1. Without the fixed voice bug and the pre-fix timeouts, the handover rate would have been 12/56 ≈ 21%.

## Root cause of FALLBACK: output cap shared with hidden reasoning
- `LLM_MAX_OUTPUT_TOKENS` is unset on staging → default **1,024** (`apps/api/src/config/environment.ts:277`), used as the `respond` cap (`agent-conversation.service.ts:501`).
- `gemini-3.8-flash` spends hidden thinking tokens inside that cap (the OpenAI-compatible endpoint does not report them in `completion_tokens`, latency audit 2026-11-10).
- Last 7 days: **13 model calls ended `max_tokens` (8) or `truncated` (5)** of 84 `gemini-3.8-flash` calls; FALLBACK turns produced only 73–169 visible output tokens.
- Uzbek drafts are longer (Latin Uzbek tokenises worse than Russian/English), so they hit the cap first — consistent with "all FALLBACK in uz-Latn".

## Recommendation
1. Staging config: `LLM_MAX_OUTPUT_TOKENS=2048` (schema allows up to 4,096). Output is billed only for generated tokens, so the cost changes only for turns that are cut today. Measure for 3–5 days: FALLBACK and `max_tokens` counts, p50/p95 latency.
2. Code (P2.6): log `finish_reason` and visible-token count per respond call in the turn timings; an explicit per-locale respond cap if Uzbek still truncates.
3. Latency after the fix is not yet measurable: 2 turns since the deploy (p50 3.9 s, p95 4.6 s). Re-measure after 50+ turns.

## NO_RESULTS (8)
Catalog searches with no match; needs a review of the queries against the demo catalog (content not read in this baseline).
