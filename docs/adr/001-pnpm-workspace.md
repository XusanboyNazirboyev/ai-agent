# ADR 001: Adopt a pnpm workspace monorepo

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The v3 specification locks D21: one pnpm workspace contains the NestJS API, a web-app placeholder, shared contracts, and shared tool configuration. The repository began as a single NestJS app at its root. Keeping the API under `apps/api` lets the web app and shared packages grow without mixing their dependencies or contracts.

## Decision

Use `apps/api`, `apps/web`, `packages/shared`, and `packages/config` as pnpm workspace packages. Root scripts delegate to workspace packages with pnpm filters. Move the existing API scaffold into `apps/api` and keep the existing local service Compose file at the repository root.

## Consequences

- API code and its tests stay together under `apps/api`.
- Shared types/config can be consumed through declared workspace dependencies instead of relative imports.
- CI, Docker build inputs, environment documentation, and scripts must account for the workspace root.
- The migration is structural and can be reverted independently of future schema or product work.
