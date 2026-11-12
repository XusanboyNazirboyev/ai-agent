# ADR 053 — Tags and custom fields (P1.5)

- Status: API half implemented (branch `feat/p1-5-tags-api`); web half separate
- Date: 2026-11-12
- Scope: Person (ADR 052) and Lead only. No companies, no conversations.

## Context
Operators need lightweight segmentation and per-tenant structured attributes on customers and leads. The data model must remain tenant-isolated, privacy-safe (erasure/merge), and additive to existing read shapes.

## Decisions
- **Entities:** tags and custom field definitions/values attach to `persons` and `leads` only.
- **Tags:** `tags` table (`id` uuid v7, `tenant_id`, `name` varchar(40) trimmed, `color` varchar(16) nullable, fixed palette token names `gray|blue|green|amber|red|purple`, `created_at`, `archived_at`). Active-name uniqueness is enforced by partial unique index `(tenant_id, lower(name)) WHERE archived_at IS NULL` in migration SQL (Prisma cannot express partial unique; schema mirrors intent with non-partial unique kept out and documented via migration). Joins: `person_tags` `(tenant_id, person_id, tag_id, created_at)` and `lead_tags` `(tenant_id, lead_id, tag_id, created_at)` with composite PKs, composite tenant FKs, `ON DELETE RESTRICT` to person/lead and `ON DELETE CASCADE` to tag, indexes on `(tenant_id, tag_id)`. Limits: max 20 tags per person/lead, max 200 active tags per tenant.
- **Custom field definitions:** `custom_field_defs` (`id`, `tenant_id`, `entity` enum `PERSON|LEAD`, `key` varchar(40) slug `^[a-z][a-z0-9_]{0,39}$` immutable, `label` varchar(80), `type` enum `TEXT|NUMBER|DATE|BOOLEAN|SELECT`, `options` jsonb for SELECT 1..50 unique strings 1..60 chars, `position` int, `created_at`, `archived_at`). Unique `(tenant_id, entity, key)`. Max 50 active definitions per tenant/entity. `type` immutable; `label` and adding SELECT options allowed; removing an in-use option allowed but stored value may display as unknown. Archiving hides definition and keeps stored values; archived key cannot be recreated with another type (409 `FIELD_KEY_TAKEN`).
- **Values:** `persons.custom_fields` and `leads.custom_fields` `jsonb NOT NULL DEFAULT '{}'`. Writes validated against active definitions: unknown/archived key -> 400 `UNKNOWN_FIELD`; wrong type -> 400 `INVALID_VALUE` (TEXT <=500 chars, NUMBER finite, DATE real `YYYY-MM-DD`, BOOLEAN boolean, SELECT in options). `null` clears a key. Archiving keeps stored values.
- **Erasure/privacy:** custom fields and tags are personal data. When contact erasure removes the last contact of a person, that person's `custom_fields` is set to `{}` and `person_tags` rows are deleted (shared helper used by retention/contact erasure path). Person erasure follows same residue semantics.
- **Merge/unmerge (ADR 052):** on merge survivor receives union of tags (capped at 20) and keeps its own custom field values, filling only keys empty on survivor from merged person. Carried changes are recorded in `person_merges.carried` jsonb `{ tagIds: string[], fields: Record<string, unknown> }` for reversibility. Unmerge removes exactly those carried tags/fields only if still unchanged; merge returns no extra reporting beyond normal response.
- **RLS:** `tags`, `person_tags`, `lead_tags`, `custom_field_defs` get ENABLE RLS + tenant-isolation policies in ADR 050 style; covered in `rls.integration.spec.ts`.
- **API:** session-guarded, tenant from principal. Tags: list/read any role with usage counts; create/update/archive OWNER/ADMIN (409 `TAG_EXISTS`, `TAG_LIMIT`), OPERATOR/VIEWER 403 on writes. Custom fields: list by entity any role; create/update/archive OWNER/ADMIN. `PUT /people/:id/tags` and `PUT /leads/:id/tags` replace set (OWNER/ADMIN/OPERATOR, VIEWER 403; unknown/archived/other-tenant tag 400 `UNKNOWN_TAG`; missing/other-tenant/merged/erased target 404). `PATCH /people/:id/custom-fields` and `/leads/:id/custom-fields` merge keys (same roles). Reads additive: `PersonItem.tags`, `PersonDetail.customFields` (active defs in position order, value null if unset), leads list/detail same additions. Filters: `tagId` (UUID, 400 `INVALID_QUERY`) on people/leads lists; single custom-field filter via `fieldKey`+`fieldValue` validated against definition (SELECT/BOOLEAN/TEXT exact match). Batched tag loading for pages (no N+1). Audit events for management/assignment actions without personal values.
- **Web:** settings “Tags and fields” page for management (read-only for OPERATOR/VIEWER), person/lead tag picker + custom field editors, list tag filters/badges, i18n `en/ru/uz-Latn`, 320px-safe layout, accessible controls.

## Risks / notes
- Partial unique index for active tag names is SQL-only; Prisma schema cannot fully represent it.
- Removing a SELECT option in use leaves stored value orphaned for display as unknown (intentional, documented).
- `person_merges.carried` is additive nullable column; existing rows remain null.
- Integration/e2e and `db:test:drift` not executed by builder per standing rules unless explicitly run and reported.

## Status (API half, 2026-11-12)
Built: `/api/v1/tags` and `/api/v1/custom-fields` CRUD (archive = DELETE), `PUT /people|leads/:id/tags`, `PATCH /people|leads/:id/custom-fields`, additive `tags` (person list/detail, lead list, conversation lead panel) and `customFields` (person detail, lead list, lead panel), `tagId` filter on people and leads lists, `fieldKey`+`fieldValue` filter on both lists (all five types, typed exact match). Code: `apps/api/src/tags/*` (pure rules in `custom-field-values.ts`), controllers in `webinbox/`. Merge stores `person_merges.carried`; unmerge removes only what was carried and is still unchanged. Erasure of the last contact, whole-person erase and merged lineage/copies clear `custom_fields` and `person_tags`. Migration and schema untouched; `db:test:drift` reports no drift.

Deviations and notes:
- Extra error codes: `FIELD_LIMIT` (409, 51st definition), `FIELD_KEY_TAKEN` also for an active duplicate key (an archived key of the same type is reactivated). Tag count above 20 on a person or lead is 409 `TAG_LIMIT`. Filter errors: `UNKNOWN_FIELD` / `INVALID_VALUE` (400) for a bad `fieldKey`/`fieldValue`, `INVALID_QUERY` when only one of the pair is given.
- Beyond the brief: erasing a contact also clears `custom_fields` and `lead_tags` of that contact's leads.
- Known residual: values and tags carried to a survivor at merge time are not removed from the survivor when only the merged person's contacts are erased (the survivor still has a live owner; the merged copy row is cleared).
- Query count of list reads is asserted for the tags batch only (one `person_tags` query per page).
