# ADR 012: Provider presets, capability table and failover routing

- **Status:** Accepted (Stage B)
- **Date:** 2026-10-23

## Context

AgentCore needs several cheap or free OpenAI-compatible providers for testing, with availability failover. A message-text heuristic for "unsupported feature" was fragile. Claude Code itself cannot use these providers ([evaluation §11](../LLM_PROVIDER_EVALUATION.md)).

## Decision

- **Presets** (`src/llm/provider-presets.ts`): versioned, secret-free config per provider: base URL, the NAME of the key variable, default models per tier (only where verified), per-model capability table (`tools`, `structured`, each marked `documented`, `unverified` or `measured`), limits, data-use notes, `trusted: false`, `integrationTarget: agentcore-llm-provider`. Missing keys/models are reported by variable name.
- **Capability table replaces the heuristic.** An unknown 400 is `LLM_INVALID_REQUEST` (no retry, no failover). `LLM_UNSUPPORTED_FEATURE` comes from the table before any request, or from a 404 (unknown model / no access, a structured provider code).
- **Router** (`src/llm/routing/`), a plain `LlmProvider`, so the core and `MeteredLlm` are unchanged. Policy is versioned config (default in code, replaceable by `LLM_ROUTING_POLICY_FILE`; per-tenant override later). Candidates are tried in order, skipping open breakers and incapable models. Failover only on errors without a billable response: rate limit, quota, unavailable/timeout, unsupported feature, auth. Never on invalid requests, cancellation, or a returned result. A timeout may have been billed and cannot be verified: since [ADR 013](013-stage-c-safety-gates.md) it fails over only when the budget can absorb a second call, and the attempt is recorded as unknown usage.
- **Breakers:** quota and auth open the whole provider; a rate limit opens one provider/model pair for `max(Retry-After, cooldown)`; consecutive transient failures open a pair.
- **Pricing safety:** `modelFor(tier)` returns a fixed reservation model, the candidate with the highest worst-case cost. The router refuses a config where no candidate dominates the others on every rate (input, output, cache writes) or where a candidate has a lower long-prompt ceiling, and the builder refuses `LLM_MAX_INPUT_BYTES` above any candidate's long-prompt threshold. Settlement prices the model that actually ran. Every candidate must be priced (`routing-free-*` snapshot, explicit ids, no wildcard), otherwise it is skipped; a tier with no candidate fails boot.
- **Data guard:** when `routed` is in `LLM_TRUSTED_PROVIDERS`, only trusted candidate providers are used. Otherwise the existing agent-mode guard applies (untrusted: no LIVE, SHADOW only on test accounts).
- **Provider-native content** (thinking blocks) is wrapped with the provider/model that produced it and stripped before being sent to a different candidate.

## Deferred (deviation from the Stage B plan, per architect memo)

- **Escalation FAST→STRONG** does not belong in the router: it cannot see guardrail outcomes and would break FAST reservation. Future: a domain-free core policy "regeneration uses STRONG".
- **Tier 0 deterministic rules** run before `MeteredLlm` in the core, not as a provider (no usage records). Language hard stop built in Stage C ([ADR 013](013-stage-c-safety-gates.md)); other rules not built.
- **Per-turn route record** (tier, failover chain) is not persisted: router stats and a failover callback exist; `agent_turns` columns need a migration (next).

## Consequences

Providers can be added by a preset plus a priced model id. Free tiers remain untrusted and fake-data only. Routing quality is unmeasured live (no routed eval run).

## Amendment 2026-11-09: paid Gemini first, free fallbacks (owner decision)

- **Decision (owner):** customer replies use the paid Gemini; the Groq, Mistral and OpenRouter keys are its fallbacks; the owner trusts these providers with customer data (`LLM_TRUSTED_PROVIDERS=routed,gemini,groq,mistral,openrouter`). Policy `builtin:gemini-primary` (selected by name through `LLM_ROUTING_POLICY_FILE`, so no file is deployed): `gemini-3.8-flash` → Groq `openai/gpt-oss-20b` (FAST) / `-120b` (STRONG) → Mistral `mistral-large-4` → OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` → `google/gemma-4-31b-it:free`. Pricing `routing-gemini-paid-2026-11-09` (sources in `pricing-catalog.ts`). LLM7 is not routed: its site publishes no prices and no data terms.
- **Found while verifying:** (1) Gemini's OpenAI-compatible endpoint answers an invalid key with HTTP 400 `INVALID_ARGUMENT` "API key not valid" and no structured reason, so a revoked Gemini key would have stopped all replies instead of failing over; that one case is now `LLM_AUTHENTICATION` (failover). Every other 400 stays `LLM_INVALID_REQUEST` with no failover, as decided above. (2) `mistral-large-4` returns message content as chunks (`thinking` and `text`); the adapter used to reject it as malformed. Only text chunks are the reply now; thinking is never returned, streamed or shown. (3) OpenRouter's free models are often rate limited upstream (HTTP 429 "Provider returned error"), hence two of them, last.
- **Live check** (`scripts/llm-failover-live.ts`, 2026-11-09, synthetic Uzbek prompt with a tool): with 0, 1, 2 and 3 providers in front broken by an invalid key, the reply came from Gemini (3.2-5.6 s), Groq (0.8-1.6 s), Mistral (3.1 s, called the tool) and OpenRouter nemotron (9.6 s). Not verified: behaviour under real rate limits of each free tier over a day; the quality of the fallbacks' Uzbek beyond one sentence; the free providers' data-retention terms (the owner accepted them).
- **To enable:** `LLM_PROVIDER=routed`, `LLM_ROUTING_POLICY_FILE=builtin:gemini-primary`, `LLM_PRICING_VERSION=routing-gemini-paid-2026-11-09`, `LLM_TRUSTED_PROVIDERS=routed,gemini,groq,mistral,openrouter`, with `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `OPEN_ROUTER_API_KEY` set. Needs a build of this branch; the local `.env` was not changed (the main worktree runs another branch without this policy).

## Amendment 2026-11-10: builtin policy `gemini-primary-fast-groq` (latency experiment, not recommended)
- `builtin:gemini-primary-fast-groq` (FAST: Groq `openai/gpt-oss-20b`, then the `gemini-primary` FAST list; STRONG unchanged; pricing `routing-gemini-paid-2026-11-09`) exists for measurement only: on 30 live eval turns it lowered the pass count by 3 (Groq missed slots) and Groq served only 12 of 28 extractions within its limits ([latency experiments](../audit/2026-11-10-latency-experiments.md)). Routed mode never sends `reasoning_effort=minimal` to Groq (HTTP 400, no failover); `gemini-3.8-flash` also rejects `minimal`.
