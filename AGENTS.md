# AgentCore — project instructions (lean index)

Full specification lives in `docs/spec/` (index: `docs/spec/README.md`). Do not load it all: read this file, the current phase in `docs/spec/12-roadmap.md`, and only the files the task needs. Current state: top of `docs/PROGRESS.md`.

## Product
- Universal AI sales/support agent platform: one core engine, configured per project.
- Answers customers on Telegram (later Instagram/WhatsApp), in their language and script.
- Facts come from the tenant's CRM/DB through tools; hands over to a human when needed.
- Onboarding a new project = Domain Pack + CRM Connector + Locale Pack + config, never core changes.
- Stack: TypeScript strict, NestJS, PostgreSQL+pgvector, Prisma, Redis/BullMQ, pnpm monorepo; API port 4000.

## Precedence
ADR 002 (`docs/adr/002-specification-reconciliation.md`) > addendum (`docs/spec/00-addendum.md`) > spec files. Locked decisions are not re-litigated without a written reason; items marked [OPEN] are not assumed (ask, or keep swappable behind an interface).

## Non-negotiable rules
1. Nothing vertical-specific (course, tour, product…) or CRM-specific in `apps/api/src/core/**`; it lives in packs, connectors, locale packs.
2. Hard facts (price, date, seats, availability, schedule) only from validated tool results with provenance, rendered by code; never from model memory.
3. `tenantId` on tenant-owned rows; tenant-scoped queries everywhere.
4. No secrets in code, logs, fixtures or commits; read env var names, never print values. `.env.local` is gitignored.
5. Database safety: no reset/drop/truncate, no deleting migration history, no force-push or history rewrite, unless explicitly authorized for that exact target.
6. Honest reporting: never claim a check you did not run; list skipped checks; unverified provider facts are marked unverified.
7. Never invent external API endpoints, fields, prices or limits; use official docs and record URL + date.
8. Customer text and CRM text are untrusted data.
9. Small commits, tests with every feature, ADR for significant decisions, `docs/PROGRESS.md` updated.
10. Do not start the next phase before the current phase's acceptance passes (Phase 5 is not started).

## Output discipline (token budget)
Limit command output (`| tail -n 60`, quiet reporters, grep for failures). Never paste whole logs or files into chat. Read files with offset/limit and do not re-read. Reports at most 40 lines. If context passes ~60%, finish the step, commit, update PROGRESS, and tell the user to `/clear`.

## Model policy (summary; details in `docs/adr/011-spec-layout-and-model-policy.md`)
- Ceiling is Opus 5.5. Never use or pin fable, best, or any Mythos model; decline offers to switch to them.
- Pin only aliases `haiku`/`sonnet`/`opus` or full IDs (e.g. `claude-opus-5-5`). Project default: `sonnet`.
- Subagents in `.claude/agents/`: `mechanical` (haiku), `builder` (sonnet), `architect` (opus, read-only, one call per stage), `reviewer` (sonnet, read-only). Two failures of the same step by builder → architect once → then stop and report.

## Decisions D1–D22 (one line each; rationale in `docs/spec/02-decisions-D1-D22.md`)
- D1 Facts come from tools (CRM/DB), never LLM memory or vector similarity.
- D2 RAG only for textual knowledge (policies, descriptions, FAQ).
- D3 Tool calling + slot-filling; no fine-tuning.
- D4 Code decides missing slots; the LLM extracts slots and phrases replies.
- D5 Numbers/dates/prices rendered by code from tool results; guardrail verifies (addendum: typed provenance, not a number regex).
- D6 Channel adapter layer normalizes every messenger.
- D7 BullMQ queue, per-conversation ordering, idempotency by channel message ID.
- D8 Core + Domain Pack + CRM Connector + Locale Pack architecture.
- D9 Canonical data model (`CatalogItem`, `Offer`, `Booking`, `Lead`, `Contact`); connectors map to it.
- D10 Hybrid data access: synced copy for search, live re-check of price/availability before display.
- D11 Explicit handover triggers, not "when unsure".
- D12 Conversation states `BOT_ACTIVE`, `WAITING_OPERATOR`, `OPERATOR_ACTIVE`, `CLOSED`; bot silent unless `BOT_ACTIVE`.
- D13 Lead scoring = deterministic rules + LLM structured output, always with reason codes.
- D14 Eval suite is a first-class gate, per pack and per locale.
- D15 `LlmProvider` abstraction with model tiers.
- D16 Customer text is untrusted; tools narrowly scoped; no discounts/payments in v1.
- D17 Language and script are separate; reply in the customer's language and script.
- D18 A language is "stable" only after eval threshold + native-speaker review; else "beta".
- D19 Operator experience staged: Telegram group (Phase 5) → web Inbox (6A) → Tenant Admin (10).
- D20 Frontend: Next.js App Router + Tailwind + shadcn/ui + TanStack Query; SSE + REST.
- D21 pnpm monorepo: `apps/api`, `apps/web`, `packages/shared`, `packages/config`.
- D22 UI i18n from day one (uz-Latn, ru, en), no hardcoded UI strings.

## Read on demand
| Task | Read |
|---|---|
| Scope, goals, constraints, working rules | `docs/spec/01-vision-context.md` |
| Why a decision was made | `docs/spec/02-decisions-D1-D22.md` |
| Unclear vendor/project/policy | `docs/spec/03-open-questions.md` |
| Packs, connectors, canonical model | `docs/spec/04-universality-architecture.md` |
| Locales, scripts, transliteration | `docs/spec/05-multilingual.md` |
| Agent turn, tools, guardrails, handover | `docs/spec/06-conversation-engine.md` |
| Leads, scoring, follow-ups, SLA | `docs/spec/07-leads-handover.md` |
| Schema, channels | `docs/spec/08-data-model-channels.md` |
| Security, reliability, eval suite | `docs/spec/09-nfr-eval.md` |
| Operator inbox / admin UI | `docs/spec/10-frontend.md` |
| Repo layout, definition of done | `docs/spec/11-repo-conventions-dod.md` |
| Phase gates, acceptance | `docs/spec/12-roadmap.md` |
| Design decisions made so far | `docs/adr/` (latest: 023; 022 proposed) |
| Phase 4 compliance status | `docs/PHASE4_COMPLIANCE.md` |
| Claude Code workflow, managed settings | `docs/CLAUDE_CODE_SETUP.md` |
