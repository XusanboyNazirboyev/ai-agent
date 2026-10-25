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
| 1 | **Scenario harness + v1 baseline** (J) | Owner sees an objective report of how today's agent performs on the suites above | `agent/testing/simulation/*`, `eval/scenarios/*`, CLI script, report | None (additive) | Harness unit tests; a judge sensitivity test (known-bad transcripts must fail) | Delete files | sonnet |
| 2 | **Agent profile + memory** (A, C, N). Memory is narrow per decision 6; no real-customer live use before the legal review | Each tenant has its own name, tone and guidance. The bot remembers context (summary), handles corrections and clears slots. Versions can be published and rolled back | `core/agent/{prompts,slots}`, new `core/profile`, `AgentVersion` + `ConversationSummary` tables (additive migration), shared schema | Profile v0 generated from today's pack and locale, so outputs are equivalent; `engine` flag | Unit, integration, scripted eval unchanged, education suite ≥ baseline | Unpublish → previous version; flag off | sonnet (opus for schema review) |
| 3 | **Playbook engine + education sales playbooks** (B, G) | Qualification, objection handling, booking flow, lifecycle stages, 2-step follow-up cadence | new `core/playbooks/*`, packs gain `playbooks[]`, `LifecycleStage`, follow-up cadence | v1 flow wrapped as `default` playbook; v2 per channel account | Engine property tests, scenario suite meets the quality bar in simulation **and** SHADOW | Flag back to v1 | opus design → sonnet build |
| 3b | **Retail pack** (config only) | Third vertical, proving universality again | `packs/retail`, mock fixtures, eval cases | `Pack-Onboarding` gate (no core change) | Retail suite ≥ bar | Remove pack | sonnet |
| 4 | **Channel contract + rich Telegram + Telegram Business** (D, D2). **Starts only after live Telegram verification evidence (shadow + live) exists (amendment A); Telegram Business only after the Premium requirement is re-verified from official docs (decision 5)** | Buttons, quick replies, typing, deep-link attribution, long-message splitting. SMBs can connect their own Telegram Business account | `channels/contract/*`, `channels/telegram/*` refactor, canonical message model, `ChannelAccount` capabilities, `secretRef` tokens | Telegram adapter behind contract; parity test vs current behaviour | **Adapter conformance suite** (Telegram reference), e2e | Previous adapter build | sonnet (opus contract review) |
| 5 | **Operator copilot + routing + analytics** (H, K) | Context pack, draft replies, language/online/least-open routing, resolution and funnel analytics | `handover/*`, `webinbox/*`, `apps/web` analytics page, outcome table | Additive; routing off by default | Integration, e2e, analytics query tests with fixed clocks | Feature flags | sonnet |
| 6 | **Studio** (L, E, M) | Owner edits profile and playbooks in forms, manages knowledge sources and glossary, test-chats a draft, runs simulations, publishes | `apps/web/studio/*`, API endpoints with RBAC (OWNER/ADMIN) | Read-only first, then edit | e2e + axe, RBAC and isolation tests | Hide routes | sonnet |
| C1 | **Instagram adapter** (D2). App Review is submitted only once this demo works (decision 4) | DMs, story replies/mentions, comment-to-DM, ad referral, 24h/HUMAN_AGENT windows | `channels/instagram/*`, policy gate | Per account, starts SHADOW | Conformance suite + window/policy tests + Meta signature tests | Disable account | sonnet |
| C2 | **Messenger adapter** | Same contract | `channels/messenger/*` | Same | Same | Same | haiku → sonnet (reuses C1) |
| C3 | **WhatsApp adapter**, only after the §4.7 reading is confirmed from Meta's official text or in writing from Meta or a BSP | Template-aware sends, opt-in store, CTWA referral | `channels/whatsapp/*`, template registry | Same | Same + template/window tests | Same | sonnet |

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
