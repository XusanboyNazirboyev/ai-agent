# DEF-007: stored timestamps 5 h off under a non-UTC session (2026-10-26)

**Status:** reproduced and fixed on `fix/def-007-timestamp-offset`, a branch off main `a19c486` that is not merged. The DEF-007 row itself lives on `docs/telegram-live-evidence`. When the two branches meet, update that row to "Fixed on `fix/def-007-timestamp-offset`".

## Reproduction against the true instant
- `agentcore_slice1` (slice 1c Groq baseline): `extract(epoch from max(tenants.created_at))` = `1792993565`. The last ledger record from the JS clock is `1793011585`. That is 18 020 s, about 5 h.
- The first version of `apps/api/src/persistence/timestamp-offset.integration.spec.ts` was run before the fix, against a dedicated database `agentcore_def007`, with the session in `Asia/Tashkent`. All 4 tests failed:
  - an explicit `2026-01-02T03:04:05.678Z` was stored as epoch ms `1767305045678` instead of `1767323045678` (−18 000 000 ms = −5 h);
  - `@default(now())` was stored 5 h before the JS clock;
  - a stored value did not equal `timestamptz '… +00'`.
- The current spec keeps that reproduction as a **control**: a session explicitly in `Asia/Tashkent` must store the instant exactly 5 h early. It therefore reproduces the defect on any server, including the UTC one in CI.
- The Prisma round trip still returned the written `Date`. This is why the earlier same-path checks (Prisma column against Prisma column) saw nothing.

## Cause (`@prisma/adapter-pg` 7.10.0, `dist/index.mjs`)
- **Write:** `mapArg` → `formatDateTime` sends `YYYY-MM-DD HH:MM:SS.mmm` built from UTC getters, with **no offset**. PostgreSQL reads an offset-less literal for `timestamptz` in the session `TimeZone`.
- **Read:** `normalize_timestamptz` replaces whatever offset PostgreSQL returns with `+00:00`. That cancels the write error for Prisma reads only.

## Fix
- **Session pin.** `postgresPoolOptions` (`apps/api/src/config/postgres-config.ts`) starts every node-postgres pool session with `-c TimeZone=UTC`. Offset-less literals then mean UTC.
  - Any `PGOPTIONS` from the environment is kept. node-postgres would otherwise drop it once `options` is set. The UTC pin comes last, so it wins over a zone named there.
- **Startup check.** `PrismaService.onModuleInit` calls `assertUtcSession` (`persistence/postgres-adapter.ts`). The API refuses to start when the session is not UTC, whatever the cause: a pooler, or a role or database setting.
- **Scope:**
  - **Covered:** everything built on `createPostgresAdapter` or `postgresPoolOptions`, which means the API, `scripts/*` and the integration specs.
  - **Not covered:** the Prisma CLI (`prisma.config.ts` → `postgresConnectionUrl`: `migrate`, `db execute`, Studio). Migrations write no timestamps, but hand-written SQL or Studio edits run in the server default zone.

## Tests
| Check | Result |
|---|---|
| Integration spec, first version (4 tests) | 4/4 failed before the fix, 4/4 pass after |
| Integration spec, current version (5 tests): control reproduces −5 h; pinned session is UTC despite a Tashkent `PGOPTIONS`; explicit Date; `@default(now())` against SQL `now()`; Date parameter against a `+00` literal | 5/5 pass (local, `agentcore_def007`) |
| Unit: pool options (UTC pin; `PGOPTIONS` kept, pin last); `assertUtcSession` accepts UTC and Etc/UTC, refuses other zones | pass |
| `apps/api` typecheck, lint, all unit tests | see the commit report |
| Full integration suite | not run locally; it needs `agentcore_test` and Redis, which another session uses. CI runs it |

## Not done; owner decisions
- **Existing rows** in local databases (`agentcore`, `agentcore_test`, `agentcore_slice1`) were written 5 h early. After this fix, Prisma reads them 5 h earlier than before, so every time window computed from them jumps by 5 h. That affects follow-up cutoffs, rolling 24 h counts, LLM budget windows and SLA ages. Correcting the rows needs a per-database investigation, a backup and an authorized, narrowly scoped plan. Not done.
- **Connection poolers.** PgBouncer's configuration docs (https://www.pgbouncer.org/config.html, read 2026-10-26) list `TimeZone` among the parameters PgBouncer tracks and restores, and say any startup parameter it does not track raises an error unless listed in `ignore_startup_parameters`. Whether the `-c TimeZone=UTC` form inside `options` passes a given PgBouncer or managed-pooler setup is *unverified*. The startup check turns a failure into a refused start, not silent shifting. The deployment target is [OPEN]. A fallback is `ALTER DATABASE … SET timezone = 'UTC'`.
- **ADR:** none added. This is a defect fix with a narrow, reversible setting, and the decision is recorded here and in `docs/PROGRESS.md`.
- **Local database:** `agentcore_def007` was created for this check, owned by the app role, with migrations applied. It is not dropped; dropping it needs authorization.
