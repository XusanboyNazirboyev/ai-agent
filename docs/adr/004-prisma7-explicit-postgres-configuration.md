# ADR 004: Prisma 7 with explicit PostgreSQL configuration

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Phase 1 initially used Prisma 6.19, whose schema requires an inline datasource URL and whose Prisma config does not replace it. The connection refactor requires removing that URL, using individual PostgreSQL environment variables for both CLI and runtime, and using Prisma's PostgreSQL driver adapter. Prisma 7 moves CLI connection URLs into `prisma.config.ts` and requires a runtime adapter.

## Decision

Upgrade `prisma` and `@prisma/client` together to 7.10.0, add `@prisma/adapter-pg`, and use the existing `pg` driver as an API runtime dependency. Switch the API package to ESM and generate the Prisma client into ignored `apps/api/src/generated/prisma` source output. Keep the model and migration history unchanged.

Validate `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` through one shared configuration helper. `POSTGRES_SSL_MODE` defaults to `verify-full`; local development and CI set `disable` explicitly. The CLI constructs a correctly encoded URL from those values; application runtime passes individual settings to one bounded `pg` adapter pool managed by the Nest singleton service. Integration checks use the corresponding `TEST_POSTGRES_*` values and refuse the development database.

Use Node 20.19+, 22.12+, or 24.x as Prisma 7 supports those Node release lines. CI uses Node 24.

## Consequences

- Prisma's major-version module/runtime changes are explicit and validated; generated client code is not committed.
- Runtime and CLI use one validation contract without exposing credentials in logs or command-line arguments.
- The connection pool has a maximum of 10 connections, a 5 second connection timeout, and a 30 second idle timeout.
- `require` offers encryption without certificate verification; `verify-full` is the secure remote default. Deployments using a private CA need a separately configured trust chain.
- [ADR 003](003-phase1-domain-model.md)'s model, isolation, and money decisions remain in force; its Prisma 6 implementation version is superseded by this ADR.
