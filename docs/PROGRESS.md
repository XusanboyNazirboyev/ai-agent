# Project progress

## Current phase: 0 — Foundation

### Phase 0 complete

- [x] Strict TypeScript NestJS API under `apps/api`, listening on port 4000.
- [x] pnpm workspace packages: `apps/api`, `apps/web` placeholder, `packages/shared`, and `packages/config`.
- [x] Shared config presets for ESLint, TypeScript, and Prettier; API test proves its import of `@agentcore/shared` resolves through the workspace.
- [x] Validated environment configuration, structured JSON logging, and `GET /health`.
- [x] Root Docker Compose services for PostgreSQL with pgvector and Redis.
- [x] CI workflow, root filter scripts, lockfile, README, ADR 001 for D21, and this progress record.
- [x] Current v3 specification is `AGENTS.md`. It was already named this in the checkout when work began; README and docs now reference that path. The downloaded `MASTER_PROMPT.md` remains v2 and stale.

### Phase 0 acceptance evidence

| Check | Result |
|---|---|
| `CI=true pnpm install --frozen-lockfile` | Pass; all five workspace projects, lockfile up to date, already up to date. |
| `pnpm lint` | Pass; `@agentcore/api` ESLint. |
| `pnpm typecheck` | Pass; shared package build and API TypeScript check. |
| `pnpm test:coverage` | Pass; 3 files, 5 tests; v8 coverage summary 100% statements, branches, functions, and lines. |
| `pnpm format:check` | Pass; all matched API TypeScript files use Prettier style. |
| `pnpm build` | Pass; shared package and Nest API builds. |
| `pnpm dev` + `GET http://127.0.0.1:4000/health` | Pass; HTTP response `{"status":"ok"}`. |
| `docker compose up -d` + `docker compose ps` | Pass; PostgreSQL (`pgvector/pgvector:pg16`) and Redis (`redis:7-alpine`) both report `Up (healthy)`. |
| CI-equivalent sequence | Pass using frozen install, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm format:check`, and `pnpm build`. |

### Commits

1. `78bccc7 chore: validated single-app baseline` — validated original root-level app before moving it.
2. Dedicated workspace migration commit — contains only the D21 structural migration and its supporting config/docs. Roll it back with `git revert <migration-commit>` to return to the validated baseline; there are no database schema or production-data changes in it.

## Repository audit by phase

| Phase | Status | Notes |
|---|---|---|
| **0 — Foundation** | **Complete** | Workspace migration and all acceptance checks above pass. |
| **1 — Domain & persistence** | Not started | No Prisma schema, migrations, seeds, domain tables, `tenantId` models, or tenant-isolation tests. No Phase 1 work was included in this change. |
| **2 — Telegram + queue** | Not started | No Telegram webhook, BullMQ processing, ordering, idempotency, debounce, retries, or echo-bot E2E. |
| **3–11 — Later phases** | Not started | No core engine exists yet, so no vertical-specific or CRM-specific code is inside it. No product UI exists, so no hardcoded UI strings are present; frontend i18n remains required when UI work begins. |

## Open Questions and phase dependencies

No Section 4 Open Question blocks completed Phase 0. Keep all unresolved items open:

- **Phase 3 / Phase 7:** Q1, first project and CRM/API details; needed for first real connector and universality proof.
- **Phase 4:** Q2, LLM vendor/models and budget; Q4, v1 customer languages; Q5, currency and price semantics.
- **Phase 5 / pilot planning:** Q3's operator channel is resolved by D19, but pilot operator count and whether operators also work in the CRM remain open. More than about three operators requires Phase 6A before pilot.
- **Phase 6:** Q6, authoritative regulated-information sources; Q8, speech-to-text provider and quality.
- **Phase 8:** Q7, Meta onboarding status.
- **Phase 9:** Q9, hosting/domain/data residency/retention.
- **Beyond v1:** Q10, identity verification for account-specific data.

Other open confirmations outside Section 4 remain unresolved: D22 UI locales, MFA (Section 12A.3), Meta messaging-window rules (Sections 8 and 12A.4), and the default tenant time zone (Section 12A.4). No defaults are selected here.

## Next

Phase 1 is the next phase, but it has not started and is not part of Phase 0 approval.
