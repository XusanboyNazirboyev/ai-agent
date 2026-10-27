# Agent platform v2 — roadmap and quality bar (Stage 0)

Companion to [ADR 026](../adr/026-agent-platform-v2.md). Slices are vertical (user-visible), ordered by value-to-risk, and built strangler-style beside v1 behind `engine: v1|v2` per channel account. **Prerequisite met:** `phase6a/web-operator-inbox` merged into `main` as `25be79b` (owner decision 1; CI run 40170183486 success). Slice 1 starts only after the owner's GO.

## Quality bar (defined before implementation; frozen 2026-10-25)
**Frozen by owner amendment C:** any change to a threshold below requires the owner's written approval and a reason recorded in this file.

**Harness.** Scenarios in YAML:
- persona: language and script, style, patience, typos
- goal and hidden facts
- mock connector fixtures
- criteria

A simulated customer (LLM) talks to an `AgentVersion` in dry-run. Grading runs deterministic checks first, then an LLM judge with stored reasons. Each scenario runs **k = 3** times and passes only if all three runs pass (pass^3).

The LLM judge is used for gating only after **calibration against ≥ 20 human-graded conversations per language**, and Uzbek judgments need native review (amendment B). Until it is calibrated, only the deterministic metrics gate.

**Cost:** the dev loop uses free or cheap providers on synthetic data. Paid runs are for gating only, within a **$50/month hard cap**. Each slice publishes a cost estimate per full suite run before any paid run (decision 2).

**Suites.**

| Suite | Scenarios | Languages | Runs |
|---|---|---|---|
| Education | ≥ 30 | uz-Latn, ru, en (+ 10 uz-Cyrl) | 90 + 30 runs |
| Tourism | ≥ 10 | uz-Latn, ru, en | 30 runs |
| Retail | ≥ 10 | uz-Latn, ru, en | 30 runs; needs the retail pack (slice 3b), **mock-only** (decision 3) |

**Metrics and thresholds per suite and language.** A slice may switch a tenant to v2 only when all blocking thresholds hold and v2 ≥ v1 on every non-blocking metric.

| Metric | Threshold | Blocking |
|---|---|---|
| Invented hard facts (price, date, seats, availability) | 0 | yes |
| False success claims (action not confirmed by connector) | 0 | yes |
| Cross-tenant data in any reply | 0 | yes |
| Correct handover (reason matches scenario) | ≥ 95% | yes |
| Reply language and script match | ≥ 98% | yes |
| Goal completion (judge) | ≥ 80% education, ≥ 70% tourism/retail; and ≥ v1 baseline + 15 points | yes |
| Slot correction handled ("not black, red") | ≥ 90% | no |
| One question per turn; no questionnaire | ≥ 95% | no |
| Turns to qualified lead | ≤ v1 baseline − 20% | no |
| Judge "natural, on-brand" score (1–5) | ≥ 4.0 mean | no |
| p95 turn latency (live model) | < 6 s | no |
| Cost per conversation | ≤ owner budget (decision 2) | no |

**Education scenario titles (30).** Each runs in 3 languages.
1. Course search with all slots in one message
2. Vague start ("I want to study")
3. Price question before choosing a course
4. Schedule/time-of-day preference
5. Online vs offline
6. Level unknown → placement offer from knowledge
7. Correction ("not IELTS, SAT")
8. Clearing a constraint ("budget doesn't matter")
9. Topic switch mid-flow and return
10. Two children, two courses
11. No matching course → alternatives
12. Course full → nearest group
13. Price objection
14. "Too far" objection
15. Trust objection ("results guaranteed?")
16. Competitor comparison
17. Discount request → NEGOTIATION handover
18. Installments → handover
19. Booking intent → proposal → confirm → lead
20. Booking intent → decline
21. Customer gives phone unprompted
22. Asks for a human
23. Complaint / angry customer
24. Regulated info (certificates, visas) with and without verified knowledge
25. Prompt injection in message
26. Mixed uz/ru code-switching
27. Returning customer (memory of interest, with consent)
28. Stalled conversation → strategy change → handover
29. After-hours message
30. Follow-up after 24h silence

**Tourism titles (10).**
1. Destination + month + party size
2. Budget-constrained
3. Sold-out date → alternatives
4. Visa question (regulated)
5. Price per person vs total
6. Correction of month
7. Group of 12 → HIGH_VALUE handover
8. Booking proposal → confirm
9. Ad-referral entry (Antalya ad)
10. Cancellation policy from knowledge

**Retail titles (10).**
1. Product search by attributes
2. Size/colour correction
3. Out of stock → alternatives
4. Price objection with tool-returned alternatives only
5. Delivery question from knowledge
6. Order intent → lead
7. Instagram story-reply entry
8. Comment-to-DM entry
9. Return/complaint → handover
10. Bulk/wholesale → handover

## Slices
Effort tier: the model tier for most of the work. Opus does design and review only.

| # | Slice | Goal / user-visible outcome | Modules touched | Migration | Tests | Rollback | Tier |
|---|---|---|---|---|---|---|---|
| 1 | **Scenario harness + v1 baseline** (J). **Built 2026-10-25** ([evidence](../evidence/slice1-v1-baseline.md)). Scenarios are JSON, not YAML (no YAML parser in the repository). Goal completion is measured deterministically until the judge is calibrated (amendment B). The paid gating baseline awaits owner approval of the estimate | Owner sees an objective report of how today's agent performs on the suites above | `agent/testing/simulation/*`, `eval/scenarios/*`, CLI script, report | None (additive) | Harness unit tests; a judge sensitivity test (known-bad transcripts must fail) | Delete files | sonnet |
| 1b-i | **Observability + harness production wiring + DEF-001** (amended 2026-10-27, owner-approved, [ADR 029](../adr/029-citable-offer-details-and-structured-auto-link.md), [plan](slice1b-offer-facts-plan.md) §6). The evidence is the free-tier "before" baseline (Groq k=1, `9a653e7`, hash `38f47101a367`), which replaces the paid gating baseline as the precondition: store the redacted blocked draft with classified flagged numbers (bounded retention); build the simulation processor with the production providers; diagnose DEF-001 with production wiring and fix product code only if confirmed | Blocked replies become measurable; the harness matches production; v1 follows up after a price answer (if DEF-001 is a real defect) | `core/agent/agent-turn.ts` (diagnostics), `agent_turns` diagnostics columns + purge job, `agent/testing/simulation/world.ts`, `leads/shown-offers.service.ts` (only if confirmed) | Additive migration (nullable diagnostics columns) | Diagnostics on/off parity, purge with a fixed clock, provider parity, DEF-001 characterisation, `edu-30` | Revert commits; nulling the diagnostics is harmless | sonnet |
| 1b-ii | **Offer details as citable facts** (ADR 029 decisions 2–5): new generic fact kinds (`date`, `weeklySchedule`, `quantity`, `attributeText`), price `currencySource` (never guessed), provenance `sourceEndpoint`/`fieldPath`, no raw digit-bearing values in model-visible tool results; the display gate is unchanged | The bot can state schedules, dates, durations and levels from connector data | `core/agent/{facts,tools}.ts`, locale packs (weekday, month and unit words; "currency not stated"), connector field maps | None | Rendering per locale, tool-output shape, EduFlow and mock fixture mapping, scripted eval with listed expectation changes | Revert | sonnet (opus review) |
| 1b-iii | **Structured auto-link** (ADR 029 decisions 6–8): typed dates, times, time ranges, price with currency, and number with a unit word link to exactly one gate-accepted fact; bare integers stay blocked; line-start list markers `^\d+[.)]\s` allowed | Fewer needless GUARDRAIL handovers without new unsourced numbers | `core/agent/guardrails.ts` | None | Link/block table including "5 people" vs `nights = 5` | Revert (back to the ADR 013 rule) | sonnet (opus review) |
| 2 | **Agent profile + memory** (A, C, N). Memory is narrow per decision 6; no real-customer live use before the legal review | Each tenant has its own name, tone and guidance. The bot remembers context (summary), handles corrections and clears slots. Versions can be published and rolled back | `core/agent/{prompts,slots}`, new `core/profile`, `AgentVersion` + `ConversationSummary` tables (additive migration), shared schema | Profile v0 generated from today's pack and locale, so outputs are equivalent; `engine` flag | Unit, integration, scripted eval unchanged, education suite ≥ baseline | Unpublish → previous version; flag off | sonnet (opus for schema review) |
| 3 | **Playbook engine + education sales playbooks** (B, G); includes the travel `highValue` threshold (DEF-002, value from the owner) | Qualification, objection handling, booking flow, lifecycle stages, 2-step follow-up cadence | new `core/playbooks/*`, packs gain `playbooks[]`, `LifecycleStage`, follow-up cadence | v1 flow wrapped as `default` playbook; v2 per channel account | Engine property tests, scenario suite meets the quality bar in simulation **and** SHADOW | Flag back to v1 | opus design → sonnet build |
| 3b | **Retail pack** (config only; resolves DEF-003) | Third vertical, proving universality again | `packs/retail`, mock fixtures, eval cases | `Pack-Onboarding` gate (no core change) | Retail suite ≥ bar | Remove pack | sonnet |
| 4 | **Channel contract + rich Telegram + Telegram Business** (D, D2). **Starts only after live Telegram verification evidence (shadow + live) exists (amendment A); Telegram Business only after the Premium requirement is re-verified from official docs (decision 5)** | Buttons, quick replies, typing, deep-link attribution, long-message splitting. SMBs can connect their own Telegram Business account | `channels/contract/*`, `channels/telegram/*` refactor, canonical message model, `ChannelAccount` capabilities, `secretRef` tokens | Telegram adapter behind contract; parity test vs current behaviour | **Adapter conformance suite** (Telegram reference), e2e | Previous adapter build | sonnet (opus contract review) |
| 5 | **Operator copilot + routing + analytics** (H, K) | Context pack, draft replies, language/online/least-open routing, resolution and funnel analytics | `handover/*`, `webinbox/*`, `apps/web` analytics page, outcome table | Additive; routing off by default | Integration, e2e, analytics query tests with fixed clocks | Feature flags | sonnet |
| 6 | **Studio** (L, E, M) | Owner edits profile and playbooks in forms, manages knowledge sources and glossary, test-chats a draft, runs simulations, publishes | `apps/web/studio/*`, API endpoints with RBAC (OWNER/ADMIN) | Read-only first, then edit | e2e + axe, RBAC and isolation tests | Hide routes | sonnet |
| C1 | **Instagram adapter** (D2). Built and demonstrated under **Standard Access**: the owner's own account and app-role users only, no App Review. App Review / Advanced Access deferred until a verified legal entity exists (decision 4, amended 2026-10-25) | DMs, story replies/mentions, comment-to-DM, ad referral, 24h/HUMAN_AGENT windows | `channels/instagram/*`, policy gate | Per account, starts SHADOW | Conformance suite + window/policy tests + Meta signature tests | Disable account | sonnet |
| C2 | **Messenger adapter** | Same contract | `channels/messenger/*` | Same | Same | Same | haiku → sonnet (reuses C1) |
| C3 | **WhatsApp adapter**, only after the §4.7 reading is confirmed from Meta's official text or in writing from Meta or a BSP | Template-aware sends, opt-in store, CTWA referral | `channels/whatsapp/*`, template registry | Same | Same + template/window tests | Same | sonnet |

**Amendment 2026-10-27 (owner):**
- Slice 1b, formerly "Fix DEF-001 after the paid gating baseline", is split into 1b-i, 1b-ii and 1b-iii on the evidence of the free-tier "before" baseline ([breakdown](../evidence/slice1c-groq-baseline-breakdown.md), [assessment](../evidence/slice1c-groq-baseline-assessment.md), on `docs/session-handoff-2026-10-26`). Thresholds are unchanged.
- **Measurement ladder:**
  1. harness wiring on the baseline agent, core-30;
  2. plus `fix/agent-code-fixes`, core-30;
  3. after 1b, the full suite.

  Same lane and scenario hash, each commit its own ledger, no run without the owner's word.

**Order and rationale.**
- 1 → 2 → 3: measure first, then the cheapest big perceived gain (persona plus memory), then the deep change (playbooks).
- 4 makes Telegram feel native.
- 5 and 6 turn quality into operability.
- C1–C3 form a parallel track that starts when Meta Business Verification and App Review are granted. Channel slices follow business value (Instagram > Messenger) and review lead time. WhatsApp comes last because of the §4.7 policy risk.

**Recommended first slice: 1 (scenario harness + v1 baseline).**
- Every later slice is gated on it.
- It is low risk (additive, no customer impact).
- It turns "feels simple" into numbers the owner can watch improve.
- It costs only a bounded live-model budget.
