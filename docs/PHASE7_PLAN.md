# Phase 7 plan — proving a universal platform (proposal, 2026-10-24)

Status: **proposal for owner review**; Phase 7 is not started. Sources: `docs/spec/12-roadmap.md` (Phase 7), `docs/spec/09-nfr-eval.md` §12, `docs/spec/04-universality-architecture.md`, the code on `phase6a/web-operator-inbox`.

## What the code shows today
| Question | Finding (evidence) |
|---|---|
| Domain-free core | `src/core/**` is scanned for domain words and forbidden imports (`core/architecture.spec.ts`). Packs live in `src/packs/*`; the pack registry is `DOMAIN_PACKS` in `src/agent/agent-conversation.service.ts` (outside core). Only one pack exists: `education`. |
| Tenants with different domains | `tenant.packKey/packVersion` selects the pack per tenant; every read is tenant-scoped; inbox and knowledge isolation are tested. No test yet runs **two different packs** side by side. |
| Channels vs domain | Telegram adapter (`src/channels/telegram`) knows nothing of packs; the agent works on normalized messages. |
| Connector contracts | `CrmConnector` with capability flags (`search`, `liveQuote`, `availability`, `createLead`, `updateLead`, `createBooking`, …), a conformance suite, a generic REST connector and a mock connector whose fixture is a fictional tourism catalog. |
| Agent tools | All six agent tools are **read-only** (`search_catalog`, `get_item_details`, `list_offers`, `check_availability`, `get_quote`, `knowledge_search`). Facts are code-rendered with provenance (D1/D5). |
| External writes | The only write is lead creation, done by code at handover time and pushed to the CRM by a background job (`lead-sync.service.ts`, statuses SYNCED/FAILED with bounded retries). The agent and channels never read the sync status, so the customer is never told a CRM write succeeded. There is **no agent-initiated, customer-confirmed business action** (e.g. "register me", "book this"). |
| Evaluation | Mock-model eval runs in CI (`agent-eval.spec.ts`); a budgeted live eval exists (`eval:live`) but is not a CI gate. Cases (education only): uz-Latn 59, uz-Cyrl 59, ru 28, en 28 (174 total; 100+ per pack met, per-locale coverage uneven). |
| Observability data | `AgentTurn` stores per turn: outcome, handover reason, tokens, estimated/actual cost, latency, tool calls, guardrail result, pack/prompt versions; `LlmUsageRecord`, budget reservations, `Lead.crmSyncStatus`, `Handover` timings, `AuditEvent`. Logs are structured JSON on stdout. No metrics endpoint, tracing, alerting or error tracker. |
| Deployment | No deploy workflow, environments, webhooks or deployments on GitHub; CI (`quality`) only. The Dockerfile runs `pnpm dev` (development image). Hosting is Open Question 9. |

## The gap that matters for "universal"
A second read-only pack would only show that slots and prompts are configurable. The product promise also includes **configured business actions** (create a lead, an enrollment, a booking) that the customer confirms and that must never be reported as done unless the connector confirms. That needs one generic capability in the core, designed once, then reused by every pack. Adding it is a core change, so it comes with an ADR **before** the second pack, and the "zero core changes" criterion is then measured on the second-pack onboarding itself.

## Proposed Phase 7 work packages and measurable acceptance
**7.0 Generic business actions — design in [ADR 022](adr/022-generic-business-actions.md) (proposed, awaiting owner decisions D-1…D-9).** Proposal → code-decided confirmation bound to a payload digest → durable execution through the outbox with a stable idempotency key → typed outcome → code-rendered customer message; connectors declare `writeIdempotency` (`native`/`lookup`/`none`) and classify failures as `executed: 'no' | 'unknown'`; unknown outcomes go to an operator, never "done". **7.0a done (ADR 023):** connector write idempotency (`native`/`lookup`/`none`), `executed` classification, durable `connector_operations` with lease and mode-aware recovery, lead sync migrated, operator resolution tool; fixes the duplicate-lead defects (lost response, concurrent jobs, lost result, crash). **7.0b implemented (ADR 024):** proposals with digest binding, exact-phrase confirmation, durable execution, verified outcome messages, handover, inbox resolution of UNCERTAIN actions; activation for real tenants waits for owner decisions D-1/D-2/D-5. Not built: customer confirmation buttons, booking/update actions.
- Done when: the ADR 022 §14 unit, integration, contract and e2e tests pass, including the outcome table for each idempotency mode, duplicate delivery/race → one remote write, SHADOW → zero writes, and the `ACTION_CLAIM` guardrail.

**7.1 Second domain through extension points only** (cross-domain test in ADR 022 §15). **Implemented:** travel pack onboarded in commit `Pack-Onboarding: travel@1` without core changes, CI gate `pnpm check:onboarding`, cross-domain lifecycle test; per-locale eval coverage for travel (7.2) is not done. A `travel` pack + the mock tourism connector + tenant config, with knowledge documents of its own.
- Done when: the onboarding commit changes nothing under `apps/api/src/core/**` (`git diff --stat <base>..<pack-commit> -- apps/api/src/core` is empty, checked in CI for pack-onboarding branches/PRs, ADR 022 §15) — or each change is justified in an ADR; one test runs an education tenant and a travel tenant **in the same process** and proves different slots, questions, tools, prompts and knowledge are used, and no CRM data, knowledge chunk, instruction, tool result or inbox event crosses tenants.
- Not acceptable as evidence: a copy of the education fixtures with renamed labels. The travel pack must exercise at least: a different required-slot set (destination, dates, party size), a regulated-information rule (visa/entry requirements → fresh source or handover), and an action (request a callback/lead) through 7.0.

**7.2 Evaluation coverage and gates.**
- Per pack and per launch locale (uz-Latn, uz-Cyrl, ru, en): ≥ 25 cases each and ≥ 100 per pack, covering these categories with a minimum of 3 cases per category per locale: normal answer, missing data / item not in catalog, ambiguity → follow-up question, typos and mixed scripts, injection attempt, regulated information, handover trigger, action confirm, action decline, action failure/unknown outcome, duplicate request.
- Metrics, computed per pack and locale: hard-fact accuracy 100% on "no invented facts" (blocking), action-claim accuracy 100% (no success claim without `CONFIRMED`, blocking), slot extraction accuracy, follow-up appropriateness (asks for exactly the missing required slot), tool selection accuracy, handover correctness, language/script match, p95 turn latency and cost per conversation (reported).
- CI gate: mock-model suite on every change to packs, prompts, tools, guardrails or locale packs (exists; extend). Live-model suite: on demand / nightly within a budget the owner sets (cost decision).
- Tenant-isolation eval cases: a prompt in tenant B asking for tenant A's offers, knowledge or instructions must get no A data (blocking).

**7.3 Observability, cost and analytics (minimum practical).**
- Read-only Analytics page (12A.6) in `apps/web` from the existing tables: first-response time, auto-resolved rate, handover rate by reason, lead capture rate and score mix, CRM sync failures, language mix, guardrail block rate, p50/p95 latency, cost per conversation and per tenant month. Tenant-scoped, role-checked.
- Alerts (in-process scan, delivered through the existing operator notifier or email): budget near limit, CRM sync failures above a threshold, handover SLA breaches, eval regression on main.
- Logs stay structured JSON without customer text (already enforced by a test); add request/turn correlation ids to every log line.
- Done when: every Section 11 metric has a tested query and a chart; alerts have tests with fixed clocks.

**7.4 Universality checklist in CI.** `architecture.spec.ts` extended to fail if `src/core/**` imports from `src/packs/**` or any connector implementation, and if a pack is referenced by name outside `src/packs` and the registry.

## Use of the mock tourism catalog
Tourism is a **validation example**, chosen because it differs from education in slots, regulated information and actions — not the product's scope. The mock connector stays fictional data; a real CRM (omonCRM or other) needs its API facts first (Open Question 1). A third, very different domain (e.g. a services business with appointment booking) is a good later check that the action framework is general.

## Hosting and observability options (decision needed with Open Question 9)
| Option | What it is | Burden | Data / tenant sensitivity | Cost |
|---|---|---|---|---|
| A. In-app (recommended start) | DB-derived metrics + Analytics page + in-process alerts + JSON logs collected by the host | Low; no new service | Data stays in our database | No vendor cost |
| B. Self-hosted open-source stack (OpenTelemetry → Prometheus/Grafana/Loki) | Metrics, logs, dashboards, alerting | Medium–high: run and secure more services | Stays on our infrastructure | Infrastructure only |
| C. Managed services (hosted error tracking / APM / logs) | Fast setup, good UX | Low | Customer text and identifiers must be redacted before sending; data residency per vendor | Paid; prices not verified here |
A is enough for Phase 7 acceptance and keeps C or B open; vendor prices and residency terms must be taken from official pages before choosing.

## Prerequisites before starting Phase 7
1. Owner approval to merge `phase4c/telegram-live-verification`, then `phase6a/web-operator-inbox` (AGENTS rule 10).
2. Owner approval of this plan, in particular 7.0 (a deliberate, ADR-backed core addition) and the eval category minimums.
3. Choice of the second validation domain (tourism mock proposed) and whether a real CRM is in scope (Open Question 1).
4. Live-eval budget (cost) and hosting/observability direction (Open Question 9; option A needs no decision to start).
