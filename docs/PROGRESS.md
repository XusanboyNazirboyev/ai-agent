# Progress — current state

History, audit and per-phase verification records: [progress-archive.md](progress-archive.md).

## Current state (updated 2026-10-23)
- **Phases 0–3** complete (monorepo, persistence, Telegram + queue, connector framework; real CRM connector blocked on Q1).
- **Phase 4 / 4B** complete: agent core, education pack, uz-Latn/uz-Cyrl/ru/en locale packs (all `beta`, not native-reviewed), claim→compute→commit pipeline, agent mode OFF/SHADOW/LIVE, turn records, failure policy, versioned pricing, OpenAI-compatible provider, token budgets, data-protection guard ([ADR 008–010](adr/)).
- **Phase 5 not started** (operator notifier, handover state machine, leads). LIVE agent mode is refused outside development until it exists.
- **Master task:** stage A done (spec layout, [ADR 011](adr/011-spec-layout-and-model-policy.md)); stage B done (presets, capability table, failover router; [ADR 012](adr/012-provider-presets-and-failover-routing.md), main `11c35fb`). **Stage C implemented on branch `stage-c/pre-live-safety-gates` (not merged), CI pending** ([ADR 013](adr/013-stage-c-safety-gates.md)): display-evidence gate, language-confidence gate (`LOW_LANG_CONFIDENCE`), typed `safety` outcome, Tier-0 language hard stop, timeout failover gated by budget with `unknown` usage accounting. Stage D (hygiene) not started.
- **Stage C evidence (local, Node 26):** lint, typecheck, format:check, build, `git diff --check` clean; unit 783 passed/7 skipped (was 672); integration 65 passed (local Postgres 18 + Redis); coverage run green (all files 80.8% lines). New specs: `display-gate`, `language-policy`, `routing/ambiguous-failover`. A mutation check (disabling the live/scope checks) made 9 display-gate tests fail. Not run: Node 24/CI, any live model call.
- **Stage C limits:** language detection is a lexical heuristic with no measured accuracy; all locales stay `beta`. Escalation is recorded as a `Handover` row only; no operator is notified (Phase 5). Other Tier-0 rules are not specified yet. Unknown (timeout) usage is a reserved upper bound counted against conversation and tenant cost limits (not the conversation token budget), distinct from spend.
- **Verification baseline (main `11c35fb`, before Stage C):** unit 672 passed/7 skipped, integration 64 passed, CI green on Node 24. No live model call has ever been made.

## Open decisions (owner)
- Q1 first project/CRM API; Q2 monetary budgets (provisional: $0.02/turn, $0.25/conversation); Q9 data residency/retention (blocks trusting any provider with real data).
- Trusting a provider for real customer data (`LLM_TRUSTED_PROVIDERS`) is an explicit owner decision.
- Native-speaker review of locale wording; free-tier rate limits for Gemini/Groq/etc. (account-specific).

## Next step
Review and commit Stage C (CI on Node 24), then stage D (hygiene); Phase 5 only on instruction.

## Known risks
- Model quality on Claude/Gemini/Ollama unmeasured (no live eval run).
- Live-quote flow (model calls `get_quote` before stating a price) is enforced by the gate but its quality is unmeasured live; a listed price on a live-quote connector now ends in a regeneration or handover.
- Client rate limiter is per process (Redis limiter = Phase 9).
- A crash between compute and commit re-bills the retry attempt (bounded by budgets).
- Leftover scratch DB `agentcore_scratch_phase4b` (to drop in stage D).
