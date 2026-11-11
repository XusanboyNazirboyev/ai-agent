# AgentCore — development roadmap (2026-11-10)

Baseline: `8dd5de0` on staging. Effort: S ≤ 3 days, M ≤ 2 weeks, L ≤ 1 month, XL > 1 month (one experienced engineer with agents). Each item keeps the project rules: tests with the feature, ADR for significant decisions, additive migrations, no vertical words in `core/**`.

## MVP to test with real businesses
**"AI-native CRM for messenger sales in Uzbekistan"**, for 3–5 pilot businesses:
1. Channels: Telegram + Instagram DM (live today) + **WhatsApp** + **website chat**; voice notes everywhere.
2. One customer card per **person** across channels, with company, tags, custom fields, timeline.
3. AI agent qualifies and answers with verified facts; hands over with a reason; **≤ 15% handover** and **≤ 5% FALLBACK** on the pilot's own eval set; p50 reply ≤ 8 s.
4. Operators: unified inbox with assignment rules, team queues, presence, unread, canned responses, SLA; tasks and reminders.
5. Pipelines (multiple) with Kanban; leads sync to Bitrix24 (live) or stay local.
6. Platform console provisions the tenant; subscription paid through **Click**.
7. Safe to operate: MFA, off-host backups with a tested restore, monitoring.

Out of the MVP: visual flow builder (a small set of built-in automations instead), campaigns/broadcasts, voice calls, Kommo connector, customer payments in chat.

## P0 — critical security and operational blockers
| # | Task | Value | Complexity | Deps | Risks | Acceptance | Effort |
|---|---|---|---|---|---|---|---|
| P0.1 | Off-host encrypted backups (S3, separate account/role, lifecycle) + documented restore drill | prevents total data loss | low | AWS | restore never tested today | nightly copy in S3; drill restores into a scratch DB and row counts match; RPO ≤ 24 h, RTO ≤ 4 h written down | S |
| P0.2 | MFA (TOTP + recovery codes) for platform admins and tenant OWNER/ADMIN | account takeover is the top multi-tenant risk | medium | — | lockout support | login requires TOTP when enabled; enforced for platform roles; integration + e2e tests | M |
| P0.3 | Secrets hygiene: instance role + Parameter Store/Secrets Manager read at boot; stop passing values through SSM command text; rotate keys that were exposed (incl. the jev key pasted in chat) | reduces blast radius | low | AWS IAM | — | no secret in `.env.production` or SSM history; rotation runbook | S |
| P0.4 | CI security gates: secret scan (gitleaks), `pnpm audit --prod` threshold, container scan (Trivy) | catches regressions | low | — | noise | CI fails on high findings; baseline file for accepted ones | S |
| P0.5 | Measured quality baseline on staging: turn timings (now logged), handover/fallback reasons by language; fix the top 3 causes | 31% handover is the main product risk | medium | — | — | weekly report; handover ≤ 20% and FALLBACK ≤ 8% on staging traffic before pilots | M |
| P0.6 | Retention: purge expired `inbound_events`, enforce `tenants.retention_settings`, data-subject deletion (erase contact + messages) | legal readiness | medium | — | accidental deletion | scheduled purge with counts; deletion endpoint for OWNER with audit; tests | M |
| P0.7 | Postgres RLS on the 6 highest-risk tables (defence in depth) | limits a missed `tenantId` filter | medium | Prisma extension | performance, migrations | cross-tenant read attempt returns 0 rows in integration tests with RLS on | M |

## P1 — CRM core and unified inbox (the MVP spine)
| # | Task | Deps | Acceptance | Effort |
|---|---|---|---|---|
| P1.1 | Person + `ContactIdentity`, merge with audit, duplicate suggestions (phone/e-mail) | — | same customer on TG and IG shows one card and one timeline; merge is reversible by audit record | L |
| P1.2 | Extract channel-neutral `InboundProcessor` (no behaviour change) | — | all channel integration tests green; Telegram file no longer hosts other channels | S |
| P1.3 | Pipelines (multiple) + Lead as opportunity (owner, amount, source, close date, lost reason) | P1.1 | two pipelines with own stages; Kanban per pipeline; Bitrix24 sync unchanged | M |
| P1.4 | Companies | P1.1 | contacts linked to a company; company card | M |
| P1.5 | Tags + custom fields (definitions + validated JSON) | — | OWNER defines fields; filters by tag/field in lists | M |
| P1.6 | Tasks + reminders (BullMQ delayed jobs) | — | task due → notification in inbox and Telegram; idempotent on retries | M |
| P1.7 | Activity timeline (outbox projection) | P1.1 | timeline shows messages, stage changes, tasks, notes, handovers in order | M |
| P1.8 | Inbox: teams/queues, assignment rules (round robin, by channel), presence (Redis), server-side read state, conversation tags, canned-response library | P1.5 | assignment works with 3 operators online/offline; unread survives browser change; e2e for each | L |
| P1.9 | Contact/lead CSV import/export | P1.5 | 10k rows import with row-level errors; export respects role | M |

## P2 — omnichannel and AI sales capabilities
| # | Task | Deps | Acceptance | Effort |
|---|---|---|---|---|
| P2.1 | WhatsApp Business Cloud API adapter (text, voice notes, templates, 24 h window) | P1.2 | real number sends/receives on staging; template outside the window | L |
| P2.2 | Website chat widget (public session, rate limit, file-free v1) | P1.2 | widget on a test site; same inbox and agent | M |
| P2.3 | Enable Instagram comment → DM (ADR 043) + keyword triggers per post | Meta permissions | real comment answered publicly and privately once | M |
| P2.4 | Messenger enablement (merge the remaining core commit; connect a Page) | Meta | real Page conversation answered | S |
| P2.5 | Click for subscriptions (Shop API Prepare/Complete, signature check, idempotent) | owner Click credentials | sandbox payment extends a subscription; replayed callbacks are no-ops | M |
| P2.6 | Uzbek answer quality: final-draft truncation, uz-Cyrl failures, native review (D18) | P0.5 | live-eval pass count up; native reviewer sign-off on templates | M |
| P2.7 | Knowledge ingestion from PDF/Word/site | — | documents with sources and dates answer regulated questions | M |
| P2.8 | Bitrix24: contact sync and two-way stage sync (ADR 034) | P1.3 | stage change in Bitrix24 appears in AgentCore within 5 min | M |
| P2.9 | Plan limits enforced (`maxChannelAccounts`, `monthlyLlmBudgetUsd`) | — | connecting a channel over the limit is refused with a clear message | S |

## P3 — automation and advanced workflows
| # | Task | Deps | Acceptance | Effort |
|---|---|---|---|---|
| P3.1 | Automation engine (versioned JSON flows, triggers: message/keyword/comment/stage/time; conditions; actions: send, assign, tag, set field, create task, call webhook, AI step; delays) on outbox + BullMQ | P1.5, P1.6 | published flow runs once per trigger (idempotent), history visible, retries bounded | XL |
| P3.2 | Visual builder UI (React Flow), draft/publish, test run with a fake contact | P3.1 | non-developer builds a comment→DM→qualify→task flow | L |
| P3.3 | Templates per pack (education, tourism, clinic) | P3.1 | new tenant starts with 3 working flows | M |
| P3.4 | Campaigns with consent and window checks | P3.1 | broadcast to a tag respects opt-out and Meta rules | L |
| P3.5 | Reels/Stories triggers, Facebook comments | P2.3 | — | M |

## P4 — voice, analytics, billing, enterprise
| # | Task | Effort |
|---|---|---|
| P4.1 | Voice calls (ADR 045) when the owner resumes them: SIP trunk, consent, recording | XL |
| P4.2 | Analytics: per-channel, per-operator, automation and campaign metrics, cost per successful task | M |
| P4.3 | Kommo connector | L |
| P4.4 | Customer payments in chat (after a D16 decision) | L |
| P4.5 | High availability: RDS, two API instances, Redis pub/sub for SSE, worker split | L |
| P4.6 | Dedicated deployment kit (Terraform/compose bundle, per-customer secrets) | M |
| P4.7 | SSO/SAML for enterprise tenants | M |

## Recommended order
P0.1 → P0.3 → P0.4 → P0.2 → P0.5 (in parallel with P1.2) → P1.1 → P1.3 → P1.5 → P1.6 → P1.7 → P1.8 → P2.5 → P2.1 → P2.2 → P0.6/P0.7 → P2.3/P2.4 → P1.4/P1.9 → P3.
