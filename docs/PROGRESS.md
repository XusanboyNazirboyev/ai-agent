# Progress — current state

History, audit and per-phase verification records: [progress-archive.md](progress-archive.md).

## Current state (updated 2026-10-23, after Stage C merge)
- **Phases 0–3** complete (monorepo, persistence, Telegram + queue, connector framework; real CRM connector blocked on Q1).
- **Phase 4 / 4B** complete: agent core, education pack, uz-Latn/uz-Cyrl/ru/en locale packs (all `beta`, not native-reviewed), claim→compute→commit pipeline, agent mode OFF/SHADOW/LIVE, turn records, failure policy, versioned pricing, OpenAI-compatible provider, token budgets, data-protection guard ([ADR 008–010](adr/)).
- **Phase 5 not started** (operator notifier, handover state machine, leads). LIVE agent mode is refused outside development until it exists.
- **Master task:** stage A done (spec layout, [ADR 011](adr/011-spec-layout-and-model-policy.md)); stage B done ([ADR 012](adr/012-provider-presets-and-failover-routing.md), main `11c35fb`); **stage C merged into `main` at `810e897`** (fast-forward; [ADR 013](adr/013-stage-c-safety-gates.md), [ADR 014](adr/014-atomic-llm-budget-reservations.md)): display-evidence gate, language-confidence gate (`LOW_LANG_CONFIDENCE`), typed `safety` outcome, Tier-0 language hard stop, atomic tenant-month and conversation budget reservations with unknown-usage exposure. Stage D (hygiene): see below.
- **Stage C evidence:** Node 24 CI green on `810e897` (feature branch). Local (Node 26): lint, typecheck, format:check, build, `git diff --check`, migration drift clean; unit 787 passed/7 skipped (was 672); integration 83 passed (local Postgres 18 + Redis, two clients as two workers for the ledger tests). Mutation checks: disabling the live/scope checks, the tenant advisory lock, or the conversation cap each made the matching tests fail. Not run: any live model call.
- **Stage C limits:** language detection is a lexical heuristic with no measured accuracy; all locales stay `beta`. Escalation is recorded as a `Handover` row only; no operator is notified (Phase 5). Other Tier-0 rules are not specified yet. Tenant-month budget is reserved atomically across workers ([ADR 014](adr/014-atomic-llm-budget-reservations.md), table `llm_budget_reservations`); unknown (timeout) usage stays counted as exposure for cost and tokens, distinct from spend. Conversation cost/token caps are enforced in the same ledger transaction (no reliance on turn ordering); no tenant-month token cap exists.
- **Earlier baseline (main `11c35fb`, before Stage C):** unit 672 passed/7 skipped, integration 64 passed. No live model call has ever been made.

## Open decisions (owner)
- Q1 first project/CRM API; Q2 monetary budgets (provisional: $0.02/turn, $0.25/conversation); Q9 data residency/retention (blocks trusting any provider with real data).
- Trusting a provider for real customer data (`LLM_TRUSTED_PROVIDERS`) is an explicit owner decision.
- Native-speaker review of locale wording; free-tier rate limits for Gemini/Groq/etc. (account-specific).

## Stage D — hygiene (checklist; the repository had no written criteria beyond "drop the scratch DB")
Derived from AGENTS.md, ADR 011 and `docs/CLAUDE_CODE_SETUP.md`. Branch `stage-d/hygiene`.
1. Claude Code config consistent and checkable: `.claude/settings.json`, four subagents, four path rules; model ceiling stated identically in AGENTS.md and the setup doc. **Done:** `apps/api/src/config/claude-config.spec.ts` (5 tests).
2. Model-restriction documentation verified against the official page (2026-10-23): `availableModels` accepts `fable` as a family, `best` is not documented there, `deniedModels` alias matching is undocumented and managed-settings only. **Done:** setup doc rewritten; recommends an allowlist; states that the repository cannot enforce the ceiling.
3. Stale active docs corrected: AGENTS.md ADR index (latest 014), README spec pointer, CI seed-twice comment. **Done.**
4. Dependency/lockfile/gitignore/secrets review: no lockfile or workspace inconsistency found; tracked-file scan for key/token/private-key patterns found nothing; no generated or machine-specific files tracked (`dist`, `coverage`, `*.tsbuildinfo`, `src/generated/prisma` are ignored; `.env.example` is the only env file tracked). Candidate, not removed: `ts-node` (apps/api devDependency) is not referenced by any script, config or doc, but `@nestjs/cli` may load it, so removal needs a separate verified change. **Done (review).**
5. Scratch database `agentcore_scratch_phase4b`: exists on the local Postgres.app, has no AgentCore marker comment. **Not dropped:** AGENTS.md rule 5 requires explicit authorization for that exact target. Owner action if wanted: `DROP DATABASE agentcore_scratch_phase4b;` (local only, after confirming nothing needs it).
6. CI covers Node 24 only while `engines` allows 20.19/22.12/24: documented, not changed (adding a matrix is a separate decision).

## Next step
Review the Stage D branch and merge it; Phase 5 only on instruction.

## Known risks
- Model quality on Claude/Gemini/Ollama unmeasured (no live eval run).
- Live-quote flow (model calls `get_quote` before stating a price) is enforced by the gate but its quality is unmeasured live; a listed price on a live-quote connector now ends in a regeneration or handover.
- Client rate limiter is per process (Redis limiter = Phase 9).
- A crash between compute and commit re-bills the retry attempt (bounded by budgets).
- Leftover local scratch DB `agentcore_scratch_phase4b` (owner decision to drop; see Stage D item 5).
- Model ceiling is not enforceable from the repository; needs managed settings applied on each machine.
