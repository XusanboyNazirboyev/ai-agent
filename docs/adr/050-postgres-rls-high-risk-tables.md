# ADR 050 — Postgres RLS on high-risk tenant tables (P0.7, defence in depth)

Status: proposed-implemented in code (owner-approved continuation, 2026-11-11). Roadmap item P0.7; finding SEC-04 in `docs/audit/2026-11-10/AGENTCORE_SECURITY_AND_PRODUCTION_REVIEW.md`.

## Context

Tenant isolation is enforced by application queries passing `tenantId` and by integration tests; there is no database-level guard. A missed filter can expose cross-tenant data. The audit roadmap requires RLS on the six highest-risk tables as defence in depth.

## Decision

1. **Tables (6, existing, tenant-scoped, high-risk):** `contacts`, `conversations`, `messages`, `leads`, `handovers`, `knowledge_chunks`. `contact_identities` is not yet present (planned P1.1) and must be included when created. Amendment (ADR 052 slice A): `persons` (Person above Contact) also has the four tenant-isolation policies, added in migration `20261118090000_person_identity`.
2. **Migration (additive):** enable RLS and create tenant-isolation policies on each table: rows are visible/mutable only when `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`. `ENABLE ROW LEVEL SECURITY` is used (not `FORCE`) so the table owner/bypass role keeps working; full enforcement requires the application role to be non-owner and `NOBYPASSRLS` in deployment (ops follow-up).
3. **Application tenant context:** `PrismaService.withTenant(tenantId, fn)` runs work inside an interactive transaction and sets `app.tenant_id` via `set_config(..., true)` (transaction-local). `RetentionService` and other tenant-batched jobs should prefer tenant-scoped context where practical. Existing queries without explicit context continue to work under an owner connection but do not gain RLS protection until the DB role is tightened.
4. **Platform/bypass access:** administrative/platform operations that must span tenants run without `app.tenant_id` and require a role with bypass privileges (separate role/connection not added in this code-only step).
5. **Safety:** no destructive DDL; policies are additive. Staging application of the migration requires a verified backup and explicit owner approval.

## Consequences

- Defence in depth improves as tenant context is adopted and the app DB role is tightened; today this is groundwork plus policy definitions and a helper.
- Queries executed outside a tenant transaction under a non-owner role would return/affect 0 rows by policy; rollout must coordinate role and code changes.
- Performance depends on indexes on `tenant_id` (already present on target tables).

## Verification

Migration SQL checked into repo. Integration test (real DB) sets `app.tenant_id` in a transaction and asserts cross-tenant reads return 0 rows on a protected table when policies apply. Full non-owner enforcement is environment-dependent and documented as follow-up.
