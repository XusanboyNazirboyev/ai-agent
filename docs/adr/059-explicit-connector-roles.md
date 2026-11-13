# ADR 059 — Explicit connector roles: deterministic connector selection (AUD-13)

Status: proposed by the reviewing agent on 2026-11-13 (audit task AUD-13 from the external audit list). Extends ADR 007 (connector config contract), ADR 032 (stored connector secrets), ADR 034 (lead sink).

## Context (read from the code on 2026-11-13)
Three runtime paths each pick "the first ACTIVE connector of the tenant, oldest `createdAt` first, that has the needed capability", silently skipping any connector whose config fails to load:
- `agent/agent-conversation.service.ts` `connectorFor` (catalog search for the agent),
- `leads/lead-sync.service.ts` `connectorFor` (lead sink, `createLead`),
- `actions/action.service.ts` `writeConnector` (write actions).

With two ACTIVE connectors the oldest one wins, whatever the tenant intends; and when the intended connector is misconfigured, the code silently falls through to a different system, so the agent could answer from, or write leads into, the wrong CRM. `tenant_connectors` is unique per `(tenant_id, connector_key)` but has no notion of which connector serves which purpose. (Catalog sync already refuses two connectors syncing the same source system, `CATALOG_SYNC_SOURCE_CONFLICT`; that guard stays.)

## Decisions
1. **A binding table, one row per tenant and role.** `tenant_connector_roles (tenant_id, role, tenant_connector_id, created_at, updated_at)`, enum `ConnectorRole` = `CATALOG | LEAD_SINK | ACTIONS`, primary key `(tenant_id, role)` (determinism is enforced by the database: at most one connector per role per tenant), composite FK `(tenant_id, tenant_connector_id)` to `tenant_connectors (tenant_id, id)` `ON DELETE CASCADE`, RLS tenant-isolation policy in the ADR 050 style.
2. **One selection function** `selectConnector(tenantId, role)` in `apps/api/src/connectors/` used by all three paths (the private copies are deleted). Rules, in order:
   a. A **bound** role: load exactly that connector. If it is not ACTIVE, its config fails to load, or it lacks the capability the role needs (`CATALOG` -> `search`, `LEAD_SINK` -> `createLead`, `ACTIONS` -> the operation asked for), return `undefined` and log `connector.bound_unavailable` (tenant, role, connector key, error name; no config values). **No fallback to another connector.**
   b. An **unbound** role: if exactly one ACTIVE connector of the tenant has the capability, use it (single-connector tenants keep working untouched). If two or more could serve it, return `undefined` and log `connector.ambiguous` with the candidate keys (fail closed: an answer from the wrong system is worse than a handover). If none, `undefined` as today.
3. **API (OWNER/ADMIN, session guard, tenant from the principal):** `GET /api/v1/connectors/roles` -> `{ items: { role, tenantConnectorId|null, connectorKey|null, status: 'BOUND'|'UNBOUND'|'AMBIGUOUS'|'UNAVAILABLE' }[] }` (always the three roles; `AMBIGUOUS` = unbound with 2+ candidates, `UNAVAILABLE` = bound but unusable), `PUT /api/v1/connectors/roles { role, tenantConnectorId: string|null }` (null unbinds). Validation: the connector belongs to the tenant, is ACTIVE, loads, and advertises the capability (400 `CONNECTOR_CAPABILITY_MISSING`, 404 `NOT_FOUND`); audit `connector.role.bound|unbound` (ids and keys only). Other roles get 403.
4. **No silent behaviour change for existing tenants:** a one-off script `apps/api/scripts/backfill-connector-roles.ts` (dry run by default, `--apply` writes) binds, per tenant and role, the connector that the old rule would pick (oldest ACTIVE with the capability) and prints a per-tenant report listing every tenant where more than one candidate existed. The reviewer runs it before the deploy; ambiguity after that is a real configuration decision for the owner. The script never runs in a migration (capabilities need the connector code).
5. **Web (later, Kilo):** a "Connector roles" block on the existing connectors settings page (three selects with the status badges above). Out of scope for S1.
6. **Catalog-less tenants (AUD-14/AUD-09) are a separate follow-up** (Domain Pack contract change: `search_catalog` is required by `packages/shared/src/domain-pack.ts`). This ADR only guarantees that an unbound or unavailable `CATALOG` role yields `undefined`, which the agent already handles as "no catalog".

## Staging of the work
S1 API (builder; reviewer verifies): migration + schema (additive), `selectConnector` + replace the three call sites, roles routes, backfill script, audit, unit tests (selection matrix) and integration tests (bound/unbound/ambiguous/unavailable, no fallback after a bound connector breaks, cross-tenant FK, RLS, role matrix, backfill dry-run vs apply, the existing agent/lead/action integration specs unchanged and green). S2 web later.

## Risks
Fail-closed ambiguity can silence the catalog for a tenant that has two search-capable connectors and no binding: mitigated by the backfill report before deploy and by the `AMBIGUOUS` status in the settings API. The agent's per-turn cost: one extra read of the binding row (indexed by the primary key) per selection, no new network calls.
