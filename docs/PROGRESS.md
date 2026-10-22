# Project progress

## Phase 0 — Foundation

### Single-app baseline

The repository contains the pre-migration NestJS app at the root. `AGENTS.md` is the current v3 specification. The downloaded `MASTER_PROMPT.md` is v2 and stale; use the repository's v3 specification as instructed.

- [x] Strict TypeScript NestJS scaffold, validated environment, structured JSON logging, and `/health` endpoint.
- [x] Docker Compose definitions for PostgreSQL with pgvector and Redis.
- [x] CI workflow, lint/format/typecheck/test scripts, README, and ADR template.
- [x] `pnpm install` reconciled `package.json` and `pnpm-lock.yaml`; Vitest is installed and configured.
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass on the single-app layout (2 test files, 4 tests).
- [x] Validated single-app baseline captured in commit `chore: validated single-app baseline`.

### v3 audit and remaining Phase 0 work

| Phase | Already present | Conflicts with v3 | Missing / status |
|---|---|---|---|
| **0 — Foundation** | The single-app baseline items above. | Root-level app conflicts with D21/Section 13's pnpm workspace layout. No `pnpm-workspace.yaml`, `apps/api`, `apps/web`, `packages/shared`, or `packages/config` exists yet. | Make the baseline commit, then migrate in a separate commit; verify workspace acceptance, `pnpm dev` + `/health`, Docker Compose health, and frozen-lockfile CI commands. |
| **1 — Domain & persistence** | Nothing implemented. | No tenant-aware model exists yet; this is a Phase 1 gap. | Prisma schema, migrations, sample data for two verticals, and tenant isolation tests are not started; no tables with `tenantId` exist. |
| **2 — Telegram + queue** | Nothing implemented. | No channel/queue code to assess. | Telegram webhook and secret verification, normalization, BullMQ ordering, idempotency, debounce, retries, and echo-bot E2E are not started. |
| **3–11 — Later phases** | Nothing implemented. | No core engine exists, so no vertical-specific or CRM-specific code is currently inside one. No frontend exists, so there are no hardcoded UI strings to flag. | Connector framework, agent, packs/locales, leads/handover, knowledge/media, web inbox and UI i18n, evaluation/analytics, Meta channels, production hardening, admin, and added languages are not started. |

### Current acceptance checks

- `pnpm lint`: pass.
- `pnpm typecheck`: pass.
- `pnpm test`: pass — 2 files, 4 tests.
- `pnpm format:check`: pass.
- `pnpm build`: pass after setting the explicit TypeScript `rootDir` required by TypeScript 6.
- `pnpm dev` + `GET http://127.0.0.1:4000/health`: pass — response `{"status":"ok"}`.
- `docker compose up` and service health: pending.
- CI-equivalent `--frozen-lockfile` commands: pending.

## Open Questions and phase dependencies

No Section 4 Open Question blocks Phase 0. Keep all open items unresolved:

- **Phase 3 / Phase 7:** Q1, first project and CRM/API details; needed for the first real connector and universality proof.
- **Phase 4:** Q2, LLM vendor/models and budget; Q4, v1 customer languages; Q5, currency and price semantics.
- **Phase 5 / pilot planning:** Q3's operator channel is resolved by D19, but pilot operator count and whether operators also work in the CRM remain open. More than about three operators requires Phase 6A before pilot.
- **Phase 6:** Q6, authoritative regulated-information sources; Q8, speech-to-text provider and quality.
- **Phase 8:** Q7, Meta onboarding status.
- **Phase 9:** Q9, hosting/domain/data residency/retention.
- **Beyond v1:** Q10, identity verification for account-specific data.

Other open confirmations outside Section 4 remain unresolved: D22 UI locales, MFA (Section 12A.3), Meta messaging-window rules (Sections 8 and 12A.4), and the default tenant time zone (Section 12A.4). No defaults are selected here.

## Approved Phase 0 sequence

1. Reconcile and validate the current single-app foundation, then commit it as `chore: validated single-app baseline`.
2. Make a separate, reversible workspace migration commit: add `pnpm-workspace.yaml`; move the API into `apps/api`; add a minimal `apps/web` placeholder and `packages/shared` / `packages/config`; update scripts, CI, Docker paths, lockfile, environment example, and README; rename/keep the specification as `AGENTS.md`.
3. Add an ADR for D21 and verify all Phase 0 acceptance checks on the migrated layout.

The migration commit must be immediately after the validated baseline. If it breaks acceptance, revert only the migration commit; it contains structural moves and workspace configuration, with no database schema or production data changes.
