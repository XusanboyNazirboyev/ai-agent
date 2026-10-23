# ADR 010: Generic OpenAI-compatible provider, token budgets and data-protection guard

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

The team wants to test the agent for free: on a Gemini free-tier key, or on a local Ollama server. Both expose an OpenAI-compatible Chat Completions endpoint. Free tiers raise three new problems.

1. **No cost signal.** A zero price means the cost budget can no longer stop a looping model.
2. **Quotas.** Quotas are small, per account and, for Gemini, not published in the docs.
3. **Data use.** Google's pricing page says Free Tier content is "Used to improve our products".

The verified facts are in [LLM_PROVIDER_EVALUATION.md](../LLM_PROVIDER_EVALUATION.md) §10.

## Decision

**Adapter.** `src/llm/openai-compatible/` implements `LlmProvider` over plain `fetch`. No vendor SDK is used and the core is unchanged.

| Concern | Behavior |
|---|---|
| Request | Messages, tools and tool results are mapped to the Chat Completions shape. `tool_choice` is never sent; `parallel_tool_calls` only when a single call is requested. |
| Output ceiling | The parameter name is configurable (`max_tokens` or `max_completion_tokens`). |
| Structured output | `json_schema`, or `json_object` with the schema in the system prompt. Zod validation decides either way. |
| Malformed tool arguments | Passed through as a string, so the core's strict validation returns `INVALID_ARGUMENTS` to the model. |
| Missing usage | Estimated from sizes and recorded with `usage_estimated = true`. |

**Errors.** Each failure has a typed code:

| Code | Cause | Retried? |
|---|---|---|
| `LLM_RATE_LIMITED` | 429 rate limit | Yes |
| `LLM_QUOTA_EXHAUSTED` | 429 with `insufficient_quota` / `credit_balance_exhausted`, or the client-side daily limit | No |
| `LLM_UNAVAILABLE` / `LLM_TIMEOUT` | 408, 5xx, network failure, timeout | Yes |
| `LLM_INVALID_REQUEST` | Invalid payload | No |
| `LLM_AUTHENTICATION` | 401 / 403 | No |
| `LLM_UNSUPPORTED_FEATURE` | 400 whose message matches a not-supported pattern (heuristic) | No |

Retries are bounded, with exponential backoff and equal jitter. They honor Retry-After up to 10 s; a longer wait fails the call. Every non-retryable failure ends in the existing `LLM_UNAVAILABLE` handover, never in `GUARDRAIL`.

**Client-side limiter.** `RateLimitedLlmProvider` wraps any provider when `LLM_RATE_LIMIT_RPM`, `_TPM` or `_RPD` is set:
- 60-second sliding windows for RPM and TPM (estimated input tokens);
- a rolling 24-hour window for RPD, which is stricter than Gemini's midnight-Pacific reset;
- a bounded wait, then a typed failure.

It is per process.

**Pricing.** Price config accepts `{ free: true }` entries, and a `'*'` wildcard for local inference. Both carry `asOf` and `sourceUrl`. The new snapshots are `gemini-free-2026-10-23` (verified free models) and `local-free-2026-10-23`.

**Token budgets.** They apply to every provider: worst-case tokens are reserved before each call against `LLM_TURN_TOKEN_BUDGET` and `LLM_CONVERSATION_TOKEN_BUDGET`, the latter summed from the ledger. Hitting either gives `BUDGET_EXCEEDED`.

**Data-protection guard.**
- `LLM_TRUSTED_PROVIDERS` defaults to `mock` only, and `LLM_ALLOW_REAL_CUSTOMER_DATA` defaults to `false`.
- An untrusted provider can never run LIVE.
- It can run SHADOW only on a channel account marked `is_test_account`, or with the override.
- A refused mode degrades to **HOLD**: the batch is closed, no model call is made and nothing is sent. The Phase 2 echo is never used as a fallback, because it would reply to real customers.
- Enforced at startup (served account) and in `agent:mode`, and re-checked on every batch.
- Startup warns when the provider is untrusted, and again when the override is active.

Anthropic is untrusted by default as well. Trusting it is an explicit owner decision once its retention terms are confirmed (Q9).

**Live eval.** `LIVE_EVAL_PROVIDER=openai-compatible` evaluates through the same adapter and limiter, priced by `LLM_PRICING_VERSION`. A token cap (`LIVE_EVAL_TOKEN_BUDGET`) applies on top of the cost cap. Reports name the provider, host and model.

## Consequences

- The agent can be tested at no cost on fake data. Results across models and providers can be compared with one report format.
- Real-channel SHADOW with Claude now needs `LLM_TRUSTED_PROVIDERS=mock,anthropic`, or the override. This is stricter than Phase 4B, and deliberately so.
- Live behavior on Gemini and Ollama is unverified until a run with a key or a local server: `json_schema` and `max_tokens` support on Gemini's compatibility layer is undocumented, and both are configurable.
- Several API processes sharing one key need a shared limiter, which is not built.
