# Phase 1 data model

The API's Prisma schema is the canonical relational model. All generated IDs use UUIDv7, database identifiers map to snake_case, and timestamps use PostgreSQL `TIMESTAMPTZ(6)`. Tenant-owned records carry a required `tenantId`; their tenant-scoped unique keys support composite foreign keys so a child cannot reference another tenant's row. Application queries must still scope reads and writes by tenant.

## Entities

| Area | Models | Purpose |
|---|---|---|
| Tenant setup | `Tenant`, `TenantConnector`, `ChannelAccount`, `Operator` | Pack/version and locale references, capabilities, retention/config JSON, secret references, channel identity, and tenant operators. Credentials are references, never plaintext tokens. |
| Customer activity | `Contact`, `Conversation`, `Message`, `ConversationSlots` | Provider-scoped customer identities, channel conversations, text-only message records with delivery/idempotency metadata, and versioned structured slot state. |
| Catalog and pricing | `CatalogItem`, `Offer`, `CatalogAlias`, `Quote` | Canonical source-backed items, exact `DECIMAL(20,6)` amounts with ISO 4217 currency and explicit pricing basis, multilingual aliases, and immutable quote facts/provenance snapshots. |
| Outcomes and operations | `Lead`, `Handover`, `Booking` | Explainable lead score and CRM sync state, typed handover summaries/state, and idempotent booking request/confirmation records. |
| Durable events | `InboundEvent`, `OutboxEvent`, `AuditEvent` | Deduplicated redacted inbound events, retryable idempotent outbox actions, and append-only audit records. Aggregate/entity references in outbox and audit are polymorphic strings; they intentionally do not point across tenant boundaries via foreign keys. |

`ChannelAccount` is tenant-owned, with an additional global uniqueness constraint on `(channelType, externalAccountId)` to prevent one provider account being attached to multiple tenants. Tenant is the ownership root; there are no global catalog or reference tables. `ItemType`, pack keys, capability IDs, slot keys, and handover reason codes are validated open strings, not closed database enums, so adding a domain pack does not require changing the core schema. Closed lifecycle sets use Prisma enums.

Handwritten migration SQL adds cross-field checks, ISO currency constraints, provider-message and send-key uniqueness, the one-open-handover partial unique index, and an append-only audit trigger. PostgreSQL row-level security is not enabled in Phase 1. The integration suite therefore verifies composite-FK isolation and tenant-scoped repository access directly.

## Deliberate boundaries

- `MessageType` is currently `TEXT`; media and channel processing are later phases.
- `InboundEvent.redactedPayload` stores only an already-redacted representation. Ingress redaction is a later channel responsibility.
- Connector and channel secrets use `secretRef` fields. Secret storage and live connectors are not implemented here.
- Locale/pack identifiers are references. Seed locales, pack keys, sample currency values, and the demo tenant data are fixtures, not launch decisions.
- A tenant timezone is required explicitly; no default is inferred while the project default remains open.
- Retention settings are typed JSON accepted only at the shared runtime-schema boundary; no purge worker is introduced here.

## Persistence commands

Run `pnpm db:generate`, `pnpm db:migrate`, and `pnpm db:seed` for local development using the explicit `POSTGRES_*` settings described in the README. Integration commands use `TEST_POSTGRES_*` and require `TEST_POSTGRES_DATABASE=agentcore_test`; the helper creates that database only when absent and marked for this test suite, then applies migrations without resetting it. See [ADR 003](adr/003-phase1-domain-model.md) for the model choices and [ADR 004](adr/004-prisma7-explicit-postgres-configuration.md) for connection configuration.
