# Bounded live evaluation: results (inconclusive)

Date: 2026-10-23 (UTC, report timestamps 18:59 to 19:03). Fictional `MockConnector` cases only; no customer data; credentials from the git-ignored `.env`, never printed. Command shape: `LIVE_EVAL=1 LIVE_EVAL_PROVIDER=routed LLM_PRICING_VERSION=routing-free-2026-10-23 LIVE_EVAL_SAMPLE=eval/live-sample.json LIVE_EVAL_BUDGET_USD=1.00 LIVE_EVAL_TOKEN_BUDGET=150000 LIVE_EVAL_MAX_CASES=27 LIVE_EVAL_MAX_CALLS=90 LIVE_EVAL_MAX_RUNTIME_MS=900000 LIVE_EVAL_MAX_OUTPUT_TOKENS=200 pnpm --filter @agentcore/api eval:live` (second run adds `LLM_ROUTING_POLICY_FILE` with a Gemini-only policy). Sample: `eval/live-sample.json` (27 cases: Uzbek Latin/Cyrillic, Russian, English, mixed-language, ambiguous or meaningless text, a reply-language request with unreadable text, course search, a listed price without live evidence, unsupported capability, invalid tool arguments, prompt injection).

**These runs do not measure model quality.** Most cases ended in a safe handover because the model call failed, so the pass rate says almost nothing about the model.

| Run | Router policy and model | Cases | Recorded model calls | Tokens | Pass | Why most failed |
|---|---|---|---|---|---|---|
| 1 | default policy, first candidate `groq` / `openai/gpt-oss-20b` | 27 | 0 | 0 | 1/27 | Every extraction request got HTTP 400 `json_validate_failed` |
| 2 | Gemini-only policy, `gemini-3.5-flash-lite` | 27 | 11 | 10 665 | 1/27 | Handovers after `LLM_INVALID_REQUEST` and `LLM_RATE_LIMITED` |
| 3 (diagnostic, 3 cases) | same as run 2 | 3 | 5 | 4 962 | 0/3 | `LLM_INVALID_REQUEST` (2), `LLM_RATE_LIMITED` (1) |

Findings (observed, one account, one day):
- **The 200-token ceiling is too small for Groq `gpt-oss-20b` extraction.** A single probe request with the real extraction schema failed at 200 and at 400 output tokens (reasoning tokens use the budget) and succeeded at 800. Failing closed worked: the turn handed over, nothing was invented. The 200-token limit was a requirement of this evaluation and was not raised.
- **Gemini `gemini-3.5-flash-lite`** completed the extraction probe within 200 tokens (correct slots), and completed 5 to 11 calls per run, but the respond step often returned `LLM_INVALID_REQUEST` and the free tier returned `LLM_RATE_LIMITED`. The cause of `LLM_INVALID_REQUEST` on the tool-calling step was not investigated further (no more live calls were spent).
- Valid tool-call rate in run 2: 5/5 of the model tool calls that happened. Structured-output validity: 26/27 (one extraction failure). Hard-fact violations shipped: 0. Fact drafts blocked by the guardrail: 0 (no reply draft was reached in most cases). Language/script match 27/27 is trivially high because handover templates are in the conversation locale. Slot accuracy 5/19 reflects the handovers, not extraction quality.
- Routing decisions: single-candidate policy in run 2, so no failover; run 1 used the default policy, where an invalid-request error is not a failover case by design.

Cost and limits:
- **Measured spend: 0 USD.** The catalog prices these models as free tier (cost 0 to the account, per `routing-free-2026-10-23`); usage was reported by the providers (tokens above). Whether the keys' accounts are on free plans was **not** verified. The bound I can state is arithmetic, not measured: at most 90 calls of at most 200 output tokens and prompts under 48 000 bytes, with token cap 150 000, on small models.
- **The USD 1.00 limit was not demonstrably enforced in a live run**: with zero-priced models a cost cap never binds. What is demonstrated: the script refuses a budget above USD 1 (`live-eval-runner.spec.ts`), the whole-run token cap, the call, case and runtime bounds and the 200-token ceiling are enforced before each case or call and covered by tests; the runs stopped by completion.
- The first accidental launch (using `timeout`, absent on macOS) made no request.

What would make a live evaluation informative: a model whose structured extraction fits the output ceiling (non-reasoning, or a larger configured limit chosen by the owner), a paid or higher-quota account so rate limits do not dominate, and surfacing the provider error per case (now printed as `[model failure: CODE]`).
