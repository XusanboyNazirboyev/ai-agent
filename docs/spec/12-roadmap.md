## 15. ROADMAP: ZERO TO PRODUCTION (phase gates)

**Phase 0: Foundation.** pnpm workspace monorepo (D21: `apps/api`, `apps/web` placeholder, `packages/shared`, `packages/config`), TS strict, lint/format, CI, Docker Compose (PostgreSQL+pgvector, Redis), validated env config, health endpoint on port 4000, logging, ADR template, PROGRESS.md. **If code already exists** (the project may have been started before this spec version), first audit it against this document, list the gaps in `docs/PROGRESS.md`, and migrate to the monorepo layout in a separate commit without breaking what already works; never redo finished work.
*Done when*: `pnpm dev` and `docker compose up` run; CI green; health check passes; workspace layout matches Section 13.

**Phase 1: Domain & persistence.** Prisma schema (Section 9): tenants + tenant config, canonical catalog/offer tables with normalized search columns, aliases, conversations/messages/leads/handovers; migrations; seed with fake data for two verticals.
*Done when*: migrations clean; seed works; `tenantId` everywhere; isolation test passes.

**Phase 2: Telegram channel + queue.** Webhook + signature check, normalized message, BullMQ ordering, idempotency, debounce, sender with retries, echo-bot end to end.
*Done when*: duplicate webhooks → one reply; per-chat ordering holds; retries work.

**Phase 3: Connector framework.** `CrmConnector` interface + capability flags, conformance test suite, `MockConnector`, `GenericRestConnector` with field mappings, sync job, circuit breaker. Then the first real connector (**[OPEN] project**; recommended: `EduFlowConnector`).
*Done when*: tools search/list offers/live-check/quote through any connector passing the conformance suite; outage handled.

**Phase 4: Agent core + packs + locales.** `LlmProvider` abstraction, tool loop, slot engine driven by pack config, reply composer with placeholder rendering, guardrails (Section 7.3), language/script detection, transliteration + normalized search, Locale Pack framework with **uz-Latn, uz-Cyrl, ru, en** (pending Open Question 4), **first pack** (recommended: education).
*Done when*: scripted dialogs in each launch language produce correct, fact-grounded replies in the right script; guardrail blocks planted wrong numbers; transliteration tests pass.

**Phase 5: Handover & leads.** State machine, triggers (Section 7.4), `OperatorNotifier` interface + `TelegramGroupNotifier` (D19), operator command API (take-over, reply, return-to-bot, close, add-note) with atomic take-over, idempotency keys and audit log (Section 12A.2), lead creation in the CRM via connector, scoring with reason codes, localized operator summaries, SLA timers/alerts.
*Done when*: each trigger has a passing test; bot silent in operator mode; two simultaneous take-overs produce exactly one winner; leads land in the CRM with score + summary; an operator can handle a full conversation from the Telegram group.

**Phase 6: Knowledge, follow-ups, media.** Knowledge ingestion + multilingual pgvector RAG with source/date; cross-lingual retrieval tests; follow-up scheduler (Telegram); speech-to-text (per Open Question 8); image understanding (optional); after-hours digest.
*Done when*: knowledge answers carry internal source/date; follow-ups honor opt-out; voice yields correct slots in launch languages.

**Phase 6A: Web Operator Inbox (apps/web).** Auth + RBAC + tenant isolation, SSE event stream with resume, conversation list/view/actions per Section 12A.4, `InboxNotifier`, UI i18n with CI key-parity check (uz-Latn, ru, en pending confirmation), responsive layout, Playwright e2e for the core flow and tenant isolation. **Must be complete before a pilot with more than ~3 operators.**
*Done when*: an operator completes the full flow (see handover → take over → reply → return to bot) in the browser; two browsers stay in sync in real time; operator of tenant A cannot access tenant B (tested); no hardcoded UI strings; e2e green in CI.

**Phase 7: Evaluation, observability, and universality proof.** Eval harness (per pack, per locale), 100+ cases per launch pack, CI gate, dashboards (including the read-only Analytics page, Section 12A.6), alerts, cost tracking. **Onboard the second pack (recommended: tourism with `OmonCrmConnector` or a mock until API is known) with zero changes in `src/core/**`.**
*Done when*: hard-fact accuracy 100% on forbidden-claims cases; dashboards cover Section 11 metrics; second vertical onboarded purely via pack + connector + config; "core files changed" = 0 (or each change justified in an ADR).

**Phase 8: Meta channels.** Instagram + WhatsApp adapters per official APIs, window/template logic, token management.
*Done when*: end-to-end on test accounts; signature verification and rate limits tested.

**Phase 9: Hardening & production.** Security review, load/soak tests, backup/restore drill, staging, CI/CD deploy (Docker), secrets management, runbooks (incident, rollback, queue backlog, connector outage, LLM outage), privacy docs, **pilot with one real project** (shadow mode: bot drafts, human sends → limited live → full).
*Done when*: pilot metrics meet agreed thresholds; rollback tested; runbooks exist.

**Phase 10: Self-serve & scale.** Tenant Admin UI (Section 12A.5: pack selection, connector setup with test connection and mapping wizard, knowledge upload, locale settings, channel connection, team/roles, eval run, audit log), operator copilot (suggested replies, labeled as drafts), quality dashboard, more connectors (amoCRM, Bitrix24...), more packs, optional public web chat widget as a new channel adapter.

**Phase 11: New languages (Karakalpak, Tajik, others).** For each language: locale pack, ≥50 native-reviewed eval cases, transliteration/normalization rules if needed, speech-to-text check, `beta` launch with conservative handover, promote to `stable` after thresholds hold.

---

## 16. FIRST ACTIONS FOR THE AGENT

1. Summarize Sections 3, 5, 6 and 12A in at most 20 lines to confirm understanding.
2. **Audit the existing repository state** (if any code exists): compare it with this spec, list what is done, what conflicts (e.g., single-app layout vs monorepo, vertical-specific code in core), and what is missing. Record it in `docs/PROGRESS.md`. Do not rewrite working code without a reason written in an ADR.
3. List which Open Questions block the next phase and which block later phases.
4. Propose a short plan for the next unfinished phase (file list), then implement after approval.
