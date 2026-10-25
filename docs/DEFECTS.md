# Known defects

Numbered, so ADRs, the roadmap and commits can refer to them. "Found by" links the evidence.

| # | Area | Defect | Found by | Status / plan |
|---|---|---|---|---|
| DEF-001 | Agent / follow-ups | A price shown through a live quote (`list_offers` then `get_quote`, rendered from fact placeholders) is **not recorded** as a `ShownOffer` or `Quote` row. The follow-up policy requires one (or a warm lead), so **v1 never follows up after answering a price question**. | Slice 1 harness; pinned by `simulation.integration.spec.ts` ("records that v1 sends no follow-up after a quoted price") | **Slice 1b**, after the paid gating baseline is measured (so the baseline stays pure v1): record the shown offer/quote, add a regression test, flip the characterisation test, and add a scenario |
| DEF-002 | Travel pack config | The travel pack has **no `highValue` threshold**, so a large group (scenario `tour-07`, 12 people) cannot hand over as `HIGH_VALUE`. | Slice 1 scenarios | Roadmap: travel pack configuration task (with the owner's threshold) alongside slice 3 |
| DEF-003 | Packs | **No retail pack.** The 10 retail scenarios (30 units) are not runnable on v1 and are reported as "not runnable (pack missing)". | Slice 1 | Roadmap slice 3b (retail pack as configuration, mock-only per decision 3) |
| DEF-004 | Tooling | `pnpm llm:smoke <provider>` **overwrote** `docs/LLM_PROVIDER_STATUS.md` with only the tested providers, deleting other rows and the observations. | Slice 1 (file restored) | **Fixed** on `slice1/scenario-harness`: rows are merged (`mergeStatus`, `smoke-status.spec.ts`) |
