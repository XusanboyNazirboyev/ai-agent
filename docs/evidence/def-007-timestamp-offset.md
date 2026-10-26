# DEF-007: stored timestamps 5 h off under a non-UTC session (2026-10-26)

**Status:** reproduced and fixed on `fix/def-007-timestamp-offset`, a branch off main `a19c486` that is not merged. The DEF-007 row itself lives on `docs/telegram-live-evidence`. When the two branches meet, update that row to "Fixed on `fix/def-007-timestamp-offset`".

## Reproduction against the true instant
- `agentcore_slice1` (slice 1c Groq baseline): `extract(epoch from max(tenants.created_at))` = `1792993565`. The last ledger record from the JS clock is `1793011585`. That is 18 020 s, about 5 h.
- The new `apps/api/src/persistence/timestamp-offset.integration.spec.ts`, before the fix, run against a dedicated database `agentcore_def007` with the session forced to `Asia/Tashkent` through `PGOPTIONS`. All 4 tests failed:
  - session `TimeZone` was `Asia/Tashkent`;
  - an explicit `2026-01-02T03:04:05.678Z` was stored as epoch ms `1767305045678` instead of `1767323045678` (−18 000 000 ms = −5 h);
  - `@default(now())` was stored 5 h before the JS clock;
  - a stored value did not equal `timestamptz '… +00'`.
- The Prisma round trip still returned the written `Date`. This is why the earlier same-path checks (Prisma column against Prisma column) saw nothing.

## Cause (`@prisma/adapter-pg` 7.10.0, `dist/index.mjs`)
- **Write:** `mapArg` → `formatDateTime` sends `YYYY-MM-DD HH:MM:SS.mmm` built from UTC getters, with **no offset**. PostgreSQL reads an offset-less literal for `timestamptz` in the session `TimeZone`.
- **Read:** `normalize_timestamptz` replaces whatever offset PostgreSQL returns with `+00:00`. That cancels the write error for Prisma reads only.

## Fix
`postgresPoolOptions` (`apps/api/src/config/postgres-config.ts`) sets `options: '-c TimeZone=UTC'`. Every pool session then runs in UTC, so the offset-less literals mean UTC. This covers the app (`createPostgresAdapter`), scripts and tests.

## Tests
| Check | Result |
|---|---|
| New integration spec (4 tests), non-UTC session simulated with `PGOPTIONS` | 4/4 failed before the fix, 4/4 pass after |
| Unit test (`environment.spec.ts`): pool options pin `TimeZone=UTC` | passes |
| `apps/api` typecheck, lint, all unit tests | pass: 51 files, 1353 passed, 7 skipped |
| Full integration suite | not run locally; it needs `agentcore_test` and Redis, which another session uses. CI runs it |

## Not done; owner decisions
- **Existing rows** in local databases (`agentcore`, `agentcore_test`, `agentcore_slice1`) were written 5 h early. After this fix, Prisma reads them 5 h earlier than before. Correcting them is a data update on named databases, which needs explicit authorization per database. Not done.
- **Connection poolers:** a pooler such as PgBouncer in transaction mode may reject or drop startup `options`. The deployment target is [OPEN]. If one is used, set `TimeZone=UTC` on the database or role instead (`ALTER DATABASE … SET timezone = 'UTC'`).
- **Local database:** `agentcore_def007` was created for this check, owned by the app role, with migrations applied. It is not dropped; dropping it needs authorization.
