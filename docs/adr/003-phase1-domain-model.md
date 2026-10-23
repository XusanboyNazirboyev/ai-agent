# ADR 003: Tenant-scoped Phase 1 persistence model

- **Status:** Accepted; Prisma connection tooling superseded by [ADR 004](004-prisma7-explicit-postgres-configuration.md)
- **Date:** 2026-10-22

## Context

Phase 1 requires durable generic tenant, catalog, conversation, lead, handover, and event records without choosing a live project, CRM, launch locale, currency policy, or hosting/retention policy. The reconciled requirements in [ADR 002](002-specification-reconciliation.md) make tenant isolation, exact money, provenance, and durable idempotency explicit.

## Decision

Use Prisma with PostgreSQL. Tenant-owned tables use required `tenantId`, tenant-scoped unique keys, and composite foreign keys for tenant-owned relations. Use UUIDv7 IDs, UTC-capable `TIMESTAMPTZ`, exact decimal money, closed database enums only for fixed lifecycle sets, and validated strings for extensible pack/domain concepts. Handwritten additive migration SQL supplies database checks, partial unique indexes, and the append-only audit trigger. Seed two generic fake tenants and use a separately marked `agentcore_test` database for real-PostgreSQL tests. The current Prisma version and connection configuration are specified in ADR 004.

This implements the workspace separation required by D21 and preserves open decisions: sample locales, currencies and pack identifiers are fixture data only; tenant timezone is mandatory and has no default; retention is unset unless configured. The schema stores secret references, not credentials. No RLS, channel processing, connector, CRM, or purge subsystem is introduced in this phase.

## Consequences

- Database constraints backstop tenant isolation and idempotency, while repositories still require explicit tenant scope.
- Core schema stays extensible for new verticals and locales without embedding CRM-specific fields.
- A new SQL invariant must be kept aligned with Prisma using reviewed migrations and the database drift check.
- The Phase 2 inbox/outbox worker must define delivery/retry semantics before it begins consuming these records.
