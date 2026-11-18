# ADR 074 — The tenant's audit log in the app (Settings → History)

Status: accepted (2026-11-18). Spec 12A.5 lists an "audit log viewer" in the Tenant Admin UI (Phase 10); until now only the platform console could read audit events (ADR 047 §4), and only its own `platform_audit_events`.

## Context
- Every tenant command already writes `audit_events` (who: `actorType` + `actorId`, what: `action`, `entityType`, `entityId`, when; `safeInputSummary` holds ids and counts, never a name, phone or message text). About 110 distinct actions are written today (measured on the test database, 2026-11-18).
- An owner asking "who moved this lead / turned off the bot / deleted this answer?" had no way to see it.

## Decision
- `GET /api/v1/audit-events?page&pageSize&category`, OWNER and ADMIN only (operators and viewers get 403), tenant-scoped, newest first (`createdAt`, then `id`), paged like the console (page size at most 100, total count).
- Nine categories chosen by action prefix in the API (`AUDIT_CATEGORIES`): conversations, leads and sales stages, contacts, channels, assistant and knowledge, external CRM, tags and fields, team and sign-in, other (everything no prefix claims). Each prefix belongs to one category.
- The actor is the operator's display name, looked up in the same tenant; otherwise "the system or the assistant", "a customer", "tezda support" (platform admin) or "a removed team member".
- Web: Settings → Team and account → **History** (`/settings/history`, managers only in the section nav, a note for other roles and no request). Each row shows a translated action label (uz-Latn, ru, en for every action written today; an unknown action shows its code), time, actor, category and the safe summary's primitive values.

## Not done
- No filter by person, date range or entity, no link from a row to the lead or conversation; the summary is shown as ids.
- Platform-side actions (`platform_audit_events`) stay in the console only.

## Checked
- Integration (`audit-log.integration.spec.ts`): order, operator names, a non-uuid actor id, categories including "other", paging, tenant isolation, 403 for OPERATOR and VIEWER, 400 for a bad category or page size, no overlapping prefixes.
- Web unit (`audit-log-page.test.tsx`): labels with the code fallback, actor fallbacks, summary filter, category filter resets to the first page, operators see the note and nothing is requested; section nav tests updated; i18n parity and style tests pass.
