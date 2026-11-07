# Performance baseline and experiment plan — 2026-11-06

## Baseline status
- **Current-HEAD baseline: not measured.** No synthetic load/soak or production/staging telemetry was available. No queue-wait, context-DB, extraction, retrieval, business-tool, generation, guardrail, commit, or send stage p50/p95/p99 was recorded.
- Throughput, per-stage error rate, cold/warm behavior, concurrency/tenant distribution, and cost per successful task are also not measured. Per-turn/model usage records exist, but the reviewed Phase 7 plan says there are no histograms/stage tracing or live analytics baseline.
- `pnpm test:e2e` wall time and unit/integration durations are test-run durations, not turn latency. Historical October evidence is from another commit/provider/run and is not a comparable current baseline.
- No real-provider call was made: explicit owner permission and a cost cap were not provided. Mock evals assess control flow, not model quality.

## Required baseline before optimization
1. Use synthetic tenant data and test-only CRM/queue endpoints; record exact commit, environment, seed, provider/model, and cache state.
2. Measure queue wait; context DB; extraction; retrieval; each business tool; generation; guardrail/regeneration; transaction commit; send. Report p50/p95/p99, throughput, error/timeout rate, tokens, cost/task, and cost/success.
3. Stratify cold/warm, concurrency levels, small/large tenants, each pack/locale, and successful/failed/handover paths. Use repeated runs and confidence intervals; no extrapolation from small samples.
4. Safety blocking metrics: cross-tenant facts, unvalidated hard facts, false success claims, unauthorized actions, and secret leakage must remain zero; any regression rolls back immediately.

## Experiment register (none run in this audit)
| Experiment | Compare and report | Quality/safety guard | Rollback |
|---|---|---|---|
| Deterministic fast paths | Existing turn vs eligible no-model path; latency/call/cost | Same acceptance cases and provenance | Restore prior router |
| Model-tier routing | Current tier vs difficulty routing; latency, tokens, cost/success | Same tool/fact/handover gates per locale | Disable routing policy |
| Bounded context | Current history vs measured limits; context DB + generation latency | Goal, slot and reference-resolution non-inferiority | Restore previous bound |
| Provider prompt cache | Supported-provider baseline vs cache; tokens/cost/latency | Tenant/version isolation and exact prompt equivalence | Turn cache off |
| Tenant/version-aware cache | No cache vs scoped cache; hit rate/latency | No cross-tenant or stale-version hit | Bypass cache |
| Read-only parallel tools | Serial vs independent safe calls; latency/error | No authorization bypass; stable output ordering | Return to serial |
| Redundant calls/stale-turn cancellation | Baseline vs dedupe/cancel; latency/cost | Never cancel committed work or checked hard facts | Disable optimization |

Every experiment must record baseline, code/config change, quality impact, latency impact, cost impact, and rollback condition before implementation.
