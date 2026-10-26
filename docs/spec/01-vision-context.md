# MASTER PROMPT — Universal AI Sales & Support Agent Platform (working name: "AgentCore")

> Audience: an AI coding agent (Claude Code, Codex, or similar) working inside this repository.
> The project instructions live in `AGENTS.md` at the repo root (canonical, read by Codex and other tools). The root `CLAUDE.md` contains only `@AGENTS.md`, so Claude Code loads the same text; never copy the instructions into both files (ADR 011, amendment 2026-10-26).
> Version: 3 (universal / multi-vertical / multilingual / frontend + operator experience). Language of this document: English.

---

## 0. HOW YOU (THE AI AGENT) MUST WORK

1. Read this entire file at the start of every session. It is the source of truth.
2. Work **phase by phase** (Section 15). Do not start phase N+1 until phase N's acceptance criteria pass.
3. Items marked **[OPEN]** are undecided. Do NOT assume an answer. Ask the human, or implement behind an interface so the decision stays swappable.
4. Items marked **[LOCKED]** are decided. Do not re-litigate them without a written reason.
5. Keep two living files: `docs/PROGRESS.md` (done / next) and `docs/adr/` (one short Architecture Decision Record per significant decision).
6. Small, reviewable commits. Every feature ships with tests. Never commit secrets.
7. Never invent external API endpoints, fields or limits (CRMs, Meta, Telegram, LLM vendors, speech providers). Read official docs or ask.
8. **Golden rule of this project: nothing vertical-specific (tourism, education, retail...) or CRM-specific may live in the core engine.** Such knowledge lives only in Domain Packs, CRM Connectors, and Locale Packs (Section 5). If you feel tempted to hardcode "tour", "course", "iPhone", "omonCRM" in core code, stop and move it into a pack or connector.
9. Before declaring a phase done, run: lint, typecheck, unit tests, integration tests, and (from Phase 7 on) the eval suite.
10. Explain non-obvious choices in comments or ADRs: *why*, not only *what*.

---

## 1. PRODUCT VISION

Build a **universal AI agent platform**: one core engine that is configured per project, not rewritten per project. The agent answers customers who write via Telegram, Instagram, WhatsApp and other messengers, connects to **whatever CRM/backend the project uses**, replies **accurately from facts**, quickly, in the customer's language and script, qualifies leads, and hands over to a human operator when needed.

Known first use cases (examples, not limits):
- **Tourism** (omonCRM: domestic + international tours). Example: "1 week in Antalya" → agent searches tours, shows price/dates, asks clarifying questions.
- **Education** (EduFlow / Learnix ERP-LMS). Example: "I want an IELTS course" → agent asks level/format/time, shows groups, prices, books a trial lesson.
- **Retail** (illustrative). Example: "I need an iPhone" → agent asks model, storage, color, shows matching item and price.
Any new project must be onboarded by **configuration (pack + connector + locale settings), not core code changes**.

Goals (priority order):
1. **Factual accuracy**: never state a price, date, availability or rule not obtained from a trusted source.
2. **Minimal lead loss**: every inbound message answered fast; every qualified lead captured even when systems fail.
3. **High autonomy**: resolve most conversations without a human; hand over only when necessary.
4. **Smooth handover**: operator receives full context.
5. **Universality**: second and third verticals onboard without touching the core.
6. **Speed and cost efficiency.**

Competitive context: Reveo (reveo.uz) is an existing Uzbekistan-based product (AI chat manager for Telegram/Instagram/WhatsApp, 6 languages, 225+ clients, self-described integrations such as amoCRM/1C/Payme). Treat its marketing claims as unverified. Our differentiation: measurable accuracy guarantees, fast onboarding via packs/connectors, strong Uzbek-language quality across scripts, transparent quality metrics.

---

## 2. CONTEXT AND CONSTRAINTS

- Developer stack **[LOCKED]**: TypeScript (strict), NestJS, PostgreSQL (+ pgvector), Prisma, Redis (BullMQ), Docker, pnpm. Dev on macOS. API on port **4000**.
- Multi-tenant **[LOCKED]**: every table has `tenantId`; each tenant has its own config (domain pack, CRM connector, channels, locales, tone). We may run a single tenant at first, but the schema and config model are multi-tenant from day one.
- First channel **[LOCKED]**: Telegram. Instagram and WhatsApp (Meta official APIs) later.
- Customers write informally, in mixed languages and scripts, sometimes by voice or photo.
- Which project is integrated FIRST **[OPEN]**: recommendation: **EduFlow/Learnix first**, because the team owns its backend and can shape its API; then tourism (omonCRM, API status unknown) as the **universality proof**. Human confirms.
- Scope warning for systems that hold customer accounts (EduFlow/LMS/ERP): v1 is **pre-sales, FAQ and booking only**. The agent must NOT disclose account-specific or personal data (grades, payments, attendance, personal info) unless identity verification exists. Account-specific questions → handover (reason `AUTH_REQUIRED`). Identity verification design is **[OPEN]** and deferred.

---
