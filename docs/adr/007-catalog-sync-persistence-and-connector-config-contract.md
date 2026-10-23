# ADR 007: Catalog sync persistence, connector config contract, and write mapping

- **Status:** Accepted for Phase 3
- **Date:** 2026-10-23

## Context

[ADR 006](006-connector-outbound-security-and-contract.md) delivered the connector framework and a pure sync core, but left four gaps. Sync results were not persisted or scheduled. The shared `TenantConnectorConfigSchema` (`fieldMappings` and `pageSize` only) contradicted the configuration connectors actually consume. Write bodies always used the canonical shape. And the full Nest application could not start, because `TelegramSender`'s `request = fetch` parameter was emitted as an unresolvable `Function` DI token.

## Decision

**Startup.** `TelegramSender` takes its transport through an explicit `@Optional() @Inject(TELEGRAM_FETCH)` token, defaulting to the global `fetch`; delivery semantics are unchanged. A DI regression test and an integration smoke test boot the real `AppModule` (database, Redis, every lifecycle hook) and call `/health`. The smoke test uses `abortOnError: false` so a DI failure is reported instead of exiting the test worker.

**One connector config contract.** The zod schemas for tenant connector configuration live in `@agentcore/shared` (`connector-config.ts`). `TenantConnectorConfigSchemas` maps each registered connector key (`generic-rest`, `mock`) to its schema, and `parseTenantConnectorConfig` reports field paths only, never values. The old flat schema was removed. Connector code and the loader both validate against this contract, and unknown keys (including any attempt to set TLS, CA or outbound-policy fields) are rejected.

**Loading tenant connectors.** `TenantConnectorLoader` builds connectors only from `ACTIVE` `tenant_connectors` rows, never from conversation input. It refuses a non-null `secret_ref` column, because credential references belong in the validated `config.auth`. If the row records capabilities, they must equal what the connector advertises.

**Sync persistence.** Migration `20261023110000_phase3_catalog_sync_runs` adds `catalog_sync_runs`: a tenant-scoped run history with a composite FK to `tenant_connectors`, status (`RUNNING`, `SUCCEEDED`, `FAILED`, `BLOCKED`), heartbeat, counts and a safe error code. Hand-written SQL adds a partial unique index allowing one `RUNNING` run per connector, non-negative counts, `finished_at` set exactly when not running, and an error code exactly for `FAILED`/`BLOCKED`. `CatalogSyncStore.applyPlan` validates every record first (including what the database CHECKs and `DECIMAL(20,6)` would otherwise reject or round). It then locks the run row and applies upserts, deactivations and the `SUCCEEDED` status in one transaction. A run recovered as stale meanwhile makes the transaction abort with nothing written. Missing items become `INACTIVE` and missing offers are soft-deleted; nothing is hard-deleted.

**Scope.** A syncing connector must declare `sourceSystem`. The reconciliation scope comes from the connector, not from the records, so an empty upstream listing still trips the mass-deactivation guard. Two connectors of one tenant may not sync the same source system.

**Processing.** `CatalogSyncQueueRuntime` is a BullMQ queue (`agentcore-catalog-sync`) beside the Telegram queue, reusing the same Redis settings; no new queue framework and no change to the outbox. Jobs are deduplicated per tenant connector, and the database index is the authoritative overlap guard. Retryable failures and "run already in progress" are retried with exponential backoff (5 attempts); permanent failures and BLOCKED runs are not. A scheduler (`CATALOG_SYNC_INTERVAL_MINUTES`, 0 disables) sweeps stale runs (`CATALOG_SYNC_STALE_AFTER_SECONDS`) and enqueues active connectors that can sync. On shutdown, in-flight syncs are aborted and close their runs as `FAILED`.

**Outbound write mapping.** A write endpoint (`createLead`, `updateLead`, `createBooking`) may declare `requestBody`, a map from a nested target path to either a canonical source (`{ from, required }`) or a static value (`{ value }`). Sources are a closed list per endpoint, plus `slots.<key>` or `details.<key>`. There are no expressions and no `eval`. Only mapped fields are sent, a missing optional source is omitted, a missing required source rejects the call before any request, and an update whose mapped fields are all absent is rejected rather than sent empty. Without `requestBody` the canonical shape is still sent. Writes remain single-attempt (ADR 006).

## Consequences

- Each sync applies its plan in one transaction (120 s timeout). Very large catalogs need batching beyond `CATALOG_SYNC_MAX_ITEMS` (default 5 000).
- Synced prices and availability are search copies; anything shown to a customer must still be re-checked live (D10).
- A tenant cannot run two connectors with the same `sourceSystem`; generic REST always uses `generic-rest`.
- The `secret_ref` column is unused and refused; a later migration can drop it once no environment depends on it.
- Run history grows without a retention policy (Open Question 9).
- No real CRM connector exists; Open Question 1 still blocks it.
