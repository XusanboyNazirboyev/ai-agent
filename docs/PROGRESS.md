# Progress — current state

History, audit and per-phase verification records: [progress-archive.md](progress-archive.md).

## Current state (updated 2026-10-23)
- **Phases 0–3** complete (monorepo, persistence, Telegram + queue, connector framework; real CRM connector blocked on Q1).
- **Phase 4 / 4B** complete: agent core, education pack, uz-Latn/uz-Cyrl/ru/en locale packs (all `beta`, not native-reviewed), claim→compute→commit pipeline, agent mode OFF/SHADOW/LIVE, turn records, failure policy, versioned pricing, OpenAI-compatible provider, token budgets, data-protection guard ([ADR 008–010](adr/)).
- **Phase 5 not started** (operator notifier, handover state machine, leads). LIVE agent mode is refused outside development until it exists.
- **In progress:** workspace/model-policy master task — stage A (spec layout, [ADR 011](adr/011-spec-layout-and-model-policy.md)), then B (provider presets + routing), C (pre-live safety gates), D (hygiene).
- **Verification baseline (main `cee36b9`):** unit 672 passed/7 skipped, integration 64 passed, CI green on Node 24. No live model call has ever been made (no key was available in earlier sessions).

## Open decisions (owner)
- Q1 first project/CRM API; Q2 monetary budgets (provisional: $0.02/turn, $0.25/conversation); Q9 data residency/retention (blocks trusting any provider with real data).
- Trusting a provider for real customer data (`LLM_TRUSTED_PROVIDERS`) is an explicit owner decision.
- Native-speaker review of locale wording; free-tier rate limits for Gemini/Groq/etc. (account-specific).

## Next step
Finish stages B–D of the master task, then Phase 5 only on instruction.

## Known risks
- Model quality on Claude/Gemini/Ollama unmeasured (no live eval run).
- Listed (non-quoted) prices can still be shown; stage C adds a display gate.
- Client rate limiter is per process (Redis limiter = Phase 9).
- A crash between compute and commit re-bills the retry attempt (bounded by budgets).
- Leftover scratch DB `agentcore_scratch_phase4b` (to drop in stage D).
