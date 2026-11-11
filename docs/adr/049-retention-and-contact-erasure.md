# ADR 049 — Retention purge and owner-initiated contact erasure (P0.6)

Status: accepted (owner approved P0.6 continuation, 2026-11-11). Roadmap item P0.6; finding SEC-08 in `docs/audit/2026-11-10/AGENTCORE_SECURITY_AND_PRODUCTION_REVIEW.md`.

## Context

`tenants.retention_settings` existed but was never read. `inbound_events.expires_at` was indexed but never set and no purge ran. Contact deletion was described only as a manual request on the public legal page. P0.6 requires: purge expired `inbound_events`, enforce `tenants.retention_settings`, and owner-initiated contact erasure with audit (code only).

## Decision

1. **Settings contract:** `TenantRetentionSettingsSchema` (`packages/shared`) accepts optional `inboundEventMinutes`, `messageDays`, `conversationDays` (strict, positive integers). An empty object means no tenant-configured retention; unknown/malformed settings are ignored per field (fail closed to "keep", never fail open to mass deletion).
2. **Inbound event expiry:** channel intake sets `inbound_events.expires_at = receivedAt + inboundEventMinutes` when configured for the tenant; existing rows with `expiresAt IS NULL` are not backfilled implicitly.
3. **Scheduled purge (`RetentionService`, `ScheduledScan`):** idempotent, batched per tenant. Deletes `inbound_events` where `expires_at <= now` (and, when `inboundEventMinutes` is configured, also rows with `expires_at IS NULL AND received_at < now - minutes` to cover pre-P0.6 rows safely). When `messageDays`/`conversationDays` are configured, purges old `messages`/`conversations` by age with tenant scoping and bounded batches; referential integrity is preserved (no cross-tenant effects). Counts are logged per run.
4. **Owner-initiated contact erasure:** `DELETE /api/v1/contacts/:id` (tenant session, OWNER only, CSRF-protected). The contact is marked erased (`deleted_at` set) and personal data is anonymized/redacted (name/phone/language/script cleared, consent revoked, provider identity replaced with a non-reversible placeholder that preserves uniqueness where required). Messages and conversation content belonging to the contact are redacted; rows required for integrity/audit are retained without personal payload. The operation writes an `audit_events` record (`contact.erased`) with safe summary (ids/counts only, no PII). Erased contacts are hidden from the contacts list (existing behavior).
5. **Safety:** tenant-scoped queries only; no global deletes; no schema-destructive changes; additive behavior. Staging/AWS data changes are out of scope for this code-only step.

## Consequences

- Retention becomes enforceable once configured; defaults remain "keep" unless set.
- Erasure is auditable and idempotent enough for operator use, but does not rewrite external provider logs or backups (those follow infra/legal process).
- Full historical backfill of `expires_at` is not automatic; purge can use `received_at` fallback when the setting is present.

## Verification

Unit tests for settings parsing, purge selection, and erasure redaction rules. Integration tests for scheduled purge counts/idempotency and the OWNER-only erase endpoint with audit and tenant isolation. Migration: none required (schema already has needed columns/indexes).
