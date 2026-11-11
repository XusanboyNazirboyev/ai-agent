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

## Amendment 2026-11-11 (review fixes)

- **Inbound event floor:** `inboundEventMinutes` below 1440 (24 h) is invalid and parsed as "keep", because deleting `inbound_events` removes the webhook idempotency record and a short window would let a redelivered webhook run twice.
- **Newest-message guard:** message purge never deletes the newest message (highest `sequence`) of a conversation, so `sequence` never restarts and the agent reply key `agent-reply:<conversation>:<sequence>` cannot collide. Candidates are chosen by a parameterised raw query (`EXISTS` a later message), so each batch makes progress and the loop terminates. Only `quotes.shown_in_message_id` has a database FK; it is set to null. Plain references are cleaned: `agent_turns.reply_message_id` and `follow_ups.message_id` set to null, `shown_offers` and `instagram_comments` rows deleted. Handovers and internal notes do not reference messages.
- **Conversation purge rules:** only CLOSED conversations older than `conversationDays` with no messages and no leads are purged. Leads (CRM records, `Restrict`) are never deleted. Handovers, quotes, slots, proposals go with the conversation by schema cascade; appointments (`Restrict`) are detached (`conversation_id` null). A cursor guarantees progress; per conversation a failure is caught, logged as `retention.conversation_purge_failed` (tenant and conversation ids only), counted, and the run continues. No silent `catch`.
- **Erasure now also covers**, in the same transaction and tenant scope: `conversation_slots.slots` set to `{}`; lead `summary` cleared and `requirements` set to `{}` (score, status, ids kept); `handovers.summary` set to `{}`; `action_proposals.payload` set to `{}` with `payloadClearedAt`; `messages.provider_chat_id` and `conversations.provider_chat_id` replaced by a non-reversible per-conversation placeholder (unique key preserved, so a later message from the same person creates a new contact and conversation); the contact's conversations are closed (`CLOSED`, assignment released, `version` bumped, language/script cleared) so the bot never answers an erased contact. The audit event still carries counts only.
