# Baseline: unclear input, short answers, normal context (2026-11-25)

Owner approved up to $0.50 of live calls on 2026-11-25, before any change to
how the agent handles unclear input or spends tokens. Nothing was changed.

## Run
- `pnpm eval:live`, `LIVE_EVAL_PROVIDER=routed`, `LLM_ROUTING_POLICY_FILE=builtin:gemini-lite`,
  `LLM_PRICING_VERSION=routing-gemini-lite-2026-11-21` (the staging setting),
  `LIVE_EVAL_MAX_OUTPUT_TOKENS=1024`, budget $0.50. Code at `a3dce43`.
- Sample: `eval/unclear-sample.json`. 25 fictional education cases (en, ru, uz-Latn): short_ambiguous 8, conversational 8,
  missing_slot 3, language_repeated_unclear 3, language_low_confidence 3.
- The runner reported $0.00 (unexplained: not checked whether these calls were priced or free-tier), 41 model calls,
  69,227 tokens (60,641 in, 8,586 out), p50 4.3 s, p95 11.7 s.

**Models actually used (from the per-call records):** extraction ran on
`nvidia/nemotron-3-ultra-550b-a55b:free` (OpenRouter) and replies on
`openai/gpt-oss-120b` (Groq), i.e. the policy's fallbacks, not Gemini lite. Why the
local run skipped Gemini was not checked (the local key was not inspected). So this
baseline is for the fallback models, not for staging's primary model; a rerun where
Gemini answers is needed before comparing with staging.

## Result: 17/25 passed
| Category | Pass | Input tokens/case | Output tokens/case | Calls/case |
|---|---|---|---|---|
| conversational | 7/8 | 2,786 | 448 | 2.2 |
| short_ambiguous | 4/8 | 1,793 | 230 | 1.0 |
| missing_slot | 3/3 | 2,006 | 380 | 1.0 |
| language_repeated_unclear | 3/3 | 0 | 0 | 0 |
| language_low_confidence | 0/3 | 5,995 | 672 | 4.0 |

Failures:
- `language_low_confidence` (edu-en-g06, edu-ru-g06, edu-uz-latn-g06): HANDOVER instead of
  CLARIFICATION_REQUIRED/LANGUAGE, after 4 calls and about 6,000 input tokens each: the most
  expensive path ends in the wrong outcome.
- `short_ambiguous`: edu7-en-15, edu7-ru-15, edu-uz-latn-29 answered instead of asking the
  missing slot; edu-uz-latn-28 handed over instead of asking for the subject.
- `conversational` edu-en-o02: stopped by BUDGET_EXCEEDED (a budget handover in a normal chat).

Pattern in the expensive failures (edu-en-g06, edu-en-o02): one extraction, then
three reply rounds that each end in more tool calls (`tool_calls`, 3 tool executions)
until the turn stops with a handover or BUDGET_EXCEEDED. The repeated tool round is
where the tokens go.

## Next (not started)
Find why low language confidence reaches 4 model calls and a handover instead of one
clarifying question, then rerun this exact sample and report before/after tokens and passes.
