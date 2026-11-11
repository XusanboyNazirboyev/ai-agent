# AgentCore — executive summary (audit 2026-11-10)

**Analysed:** `origin/feat/production-pilot` at `8dd5de0` (identical to `feat/integration-2026-11-10`; the build running on staging since 2026-11-10). Read-only audit: no source, schema, env or branch was changed. Companion documents in this folder: [gap analysis](AGENTCORE_PRODUCT_GAP_ANALYSIS.md), [architecture](AGENTCORE_ARCHITECTURE_RECOMMENDATION.md), [data model](AGENTCORE_DATA_MODEL_REVIEW.md), [roadmap](AGENTCORE_DEVELOPMENT_ROADMAP.md), [security and production](AGENTCORE_SECURITY_AND_PRODUCTION_REVIEW.md). Predecessor: `docs/audit/2026-11-06-*` (older tree, `feat/dev-mock-connector` at `18decb2`); where they disagree, this audit is newer.

## Maturity in one line
A **pilot-grade AI sales and support agent with an operator inbox and a platform console** — strong engine, real channels, honest guardrails — but **not yet a CRM**: there are no companies, deals, tasks, tags, custom fields, cross-channel identities or automation flows.

## Evidence levels used everywhere
`C` code exists · `T` automated tests pass · `W` wired into the running app · `P` external provider connected · `R` real-world behaviour observed on staging · `D` production deployment (there is **no production**; staging is the only deployment).

## Biggest strengths (verified)
1. **Hard facts never come from the model.** Prices, availability and dates are code-rendered from tool results with provenance and a guardrail (`apps/api/src/core/agent/`, decision D5, ADR 029). This is the product's core differentiator and it is real (`C T W R`).
2. **Two live channels with real traffic.** Telegram and Instagram DM answer real messages on staging (last 7 days: 72 Telegram and 11 Instagram inbound messages), including **voice notes in Uzbek/Russian answered in text** — Instagram voice verified with a real message on 2026-11-10 after a same-day fix.
3. **Operator collaboration.** Web inbox with take-over / return-to-bot, handover with SLA alerts, internal notes, realtime SSE, Telegram operator group (`C T W R`).
4. **Tenant discipline and safety engineering.** `tenantId` on every tenant row, composite unique keys, idempotent webhooks and outbox, SSRF-guarded outbound HTTP, signed webhooks, CSRF, encrypted channel/connector secrets, LLM budget ledger.
5. **CRM connector foundation that works.** Bitrix24 lead sink is live (3 of 4 staging leads synced); generic REST catalog connector with conformance tests.
6. **Platform management (new).** Platform console, subscriptions with grace/expiry enforcement, invite-only onboarding and tenant team RBAC (ADR 047) deployed to staging on 2026-11-10.
7. **Engineering hygiene.** 2,284 API unit, 583 integration, 112 e2e and 120 web tests; CI with schema drift check, eval and e2e; automatic staging deploy by OIDC + SSM; 46 ADR files.

## Biggest blockers
| # | Blocker | Why it matters |
|---|---|---|
| 1 | **No cross-channel customer identity** (`Contact` is unique per channel account) | The "one AI agent across all channels" promise and any CRM view of a person are impossible without it. |
| 2 | **CRM core is thin**: no Company, Deal/multiple pipelines, Task/reminder, Tag, custom fields, activity timeline, import/export | A business cannot run sales in AgentCore; it can only receive qualified leads. |
| 3 | **Backups are on the same host, never restore-tested; one EC2 instance** | One disk or instance loss loses all tenant data. |
| 4 | **No MFA** for platform or tenant owners; **tenant isolation is by convention** (no Postgres RLS) | Highest-impact security risks for a multi-tenant SaaS. |
| 5 | **Answer quality**: 31% of staging turns end in handover, 13% FALLBACK (last 7 days, 61 turns) | Below what a paying business will accept; latency fix deployed but not yet measured on staging. |
| 6 | **No automation engine** (no flows, triggers, campaigns) and **no WhatsApp / website chat** | The two largest product gaps against ManyChat and Jivo/Chatra. |
| 7 | **Payments**: subscription billing is recorded by hand; **Click is not built**; customer payments do not exist | Blocks self-sustaining SaaS revenue and any "pay in chat" flow. |

## Most important next steps
1. **P0 (1–2 weeks):** off-host encrypted backups + a restore drill; MFA (TOTP) for platform and tenant OWNER/ADMIN; secret hygiene (move host secrets out of SSM command history and `.env.production` into Parameter Store with an instance role); CI secret and dependency scanning; a measured answer-quality baseline on staging (turn timings and handover reasons).
2. **P1 (the MVP core):** cross-channel contact identity; companies; one opportunity model (keep `Lead`, add multiple pipelines); tasks and reminders; tags and custom fields; activity timeline; assignment rules, team queues, presence and server-side unread state; canned responses.
3. **P2:** WhatsApp Business (Cloud API) and a website chat widget; Instagram comment-to-DM enabled with keyword triggers; quality work on Uzbek answers and handover reasons; Click for subscriptions.

## Recommended first implementation phase
**P0 + P1 "CRM spine"**: identity, opportunity/pipeline, tasks, tags/fields, timeline and inbox assignment — built as additive migrations in the existing modular monolith. It is the smallest coherent step that turns a good AI agent into an AI-native CRM a real business can run its day on (see the MVP definition in the [roadmap](AGENTCORE_DEVELOPMENT_ROADMAP.md)).
