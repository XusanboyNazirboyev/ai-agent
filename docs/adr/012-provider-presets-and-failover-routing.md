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
