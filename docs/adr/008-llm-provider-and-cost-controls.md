# ADR 008: LLM provider, agent core control, and cost enforcement

- **Status:** Accepted for Phase 4 (provider choice provisional until the opt-in live evaluation runs)
- **Date:** 2026-10-23

## Context

Phase 4 needs an LLM behind the generic agent core (D3–D5, D15). The master specification left the vendor and budget open (Open Question 2). The owner delegated the vendor and model choice, but gave no monetary budget. No API key exists in the development environment, so no live model call could be made. The evidence is in [LLM_PROVIDER_EVALUATION.md](../LLM_PROVIDER_EVALUATION.md).

## Decision

**Provider and models.** The Anthropic Claude API through the official TypeScript SDK (`@anthropic-ai/sdk` 1.1.0), with `claude-haiku-5-5` for both FAST (extraction) and STRONG (tool selection and reply drafting). Anthropic and OpenAI tied on the weighted criteria; the tie-breakers are listed in the evaluation. STRONG may be set to `claude-sonnet-5-5` by configuration once live results justify it. There is no automatic fallback to another provider or model, and no server-side refusal fallback: a refusal becomes a code-side handover.

**Abstraction.** `core/llm/llm-provider.ts` defines `LlmProvider` (`generateStructured`, `generateWithTools`, `modelFor`), with provider-neutral messages, tool calls, usage, stop reasons and `LlmError` codes. Vendor types stay in `src/llm/anthropic/`. Provider-native assistant content (thinking blocks) is carried opaquely and replayed unchanged. The adapter disables SDK retries and retries itself (at most 2 retries, honoring `retry-after`, abortable), so the attempt count is accurate; failed requests are not billed. `ScriptedLlmProvider` is the deterministic offline provider for tests, CI and `LLM_PROVIDER=mock` (the default).

**Cost enforcement.** Money is integer nano-USD, priced from a versioned snapshot (`anthropic-2026-10-23`, checked against the official page) and never looked up per request; an unpriced model cannot run. `MeteredLlm` is the only path to a provider:
1. Estimate input size (UTF-8 bytes plus fixed overhead).
2. Clamp output to `LLM_MAX_OUTPUT_TOKENS`.
3. **Reserve the worst-case cost** against the turn, conversation and optional tenant-monthly limits, and refuse the call if it does not fit.
4. Call the provider.
5. Settle the reservation to the provider-reported cost, recording any underestimate as overshoot.
6. Record usage.

Call, tool-round and tool-call counts are bounded per turn. Every limit has a bounded default, so a missing variable cannot produce an unbounded loop. The output bound is exact; the input bound is a conservative estimate that is reconciled after the call. Monetary defaults are provisional, not owner-approved.

**Usage ledger.** `llm_usage_records` (additive migration `20261023150000_phase4_llm_usage_records`) stores tenant, conversation, turn key, provider, model, tier, purpose, token counts by category, cost, reservation, pricing version, duration, attempts and outcome. It is unique on (tenant, provider, response id), so re-recording a response is idempotent; a retried turn makes new, billed requests and records them. It holds no prompts or text. It deliberately has no FK to conversations, so cost history survives content deletion. Conversation and monthly spend are summed from it before each turn.

**Agent core control.** The model only proposes slot values, tool calls and wording. Code does the rest:
- detects language and script;
- validates slots against the Domain Pack;
- routes handovers;
- asks one question at a time;
- runs the first search itself, so value is delivered early;
- authorizes every tool call (pack-enabled, connector-supported, schema-valid, ids from this turn's own results, deduplicated, time-bound, output re-validated against canonical schemas);
- renders every hard fact from tool results through `{{F<n>}}` references with locale formatting;
- runs a guardrail on the draft (unknown or stale facts, unsourced numbers, currencies, forbidden claims, internal markers, language and script);
- regenerates once, then falls back to a code-rendered reply.

Customer text is sanitized and delimited as data; policy lives only in the system prompt. `src/core/**` stays free of domain words and specific imports, enforced by `core/architecture.spec.ts`.

**Packs and locales.** The Domain Pack contract is shared (`packages/shared/src/domain-pack.ts`). The first pack is `education@1`. Locale Packs `uz-Latn`, `uz-Cyrl`, `ru` and `en` are all `beta` with `nativeReviewed: false`; the registry refuses `stable` without review (D18). Uzbek Latin↔Cyrillic transliteration and script-insensitive matching live in shared normalization.

## Consequences

- Deterministic CI needs no key and makes no billable call. The live evaluation is opt-in and budget-capped.
- Model quality, Uzbek quality and real per-turn token counts are unmeasured until a key exists and the live run happens.
- Switching STRONG to Sonnet 5.5 is about 20x the response-call cost and needs a larger conversation budget.
- The agent is not yet wired into the Telegram processor: that processor builds replies inside a transaction that holds a per-conversation advisory lock, and must move to claim / generate / persist phases first.
- Adding another provider means one new adapter and a pricing-snapshot entry; the core does not change.
