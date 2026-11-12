# ADR 052 — Person above Contact: cross-channel customer identity and merge (P1.1)

Status: slice A implemented (2026-11-11, branch `feat/p1-1-person-slice-a`, not merged); slice B API implemented (2026-11-11, branch `feat/p1-1-person-slice-b`, web screens built separately, not merged); slices C-D designed (2026-11-11, branch `feat/p1-1-person-slice-cd`). Roadmap item P1.1; `docs/audit/2026-11-10/AGENTCORE_DATA_MODEL_REVIEW.md` §3.1; blocker 1 in `AGENTCORE_EXECUTIVE_SUMMARY.md`. Depends on P1.2 (ADR 051, channel-neutral inbound processor) only for file layout, not for behaviour.

## Context
`Contact` is unique per `[tenantId, channelAccountId, providerUserId]` (`schema.prisma`), so the same human on Telegram and Instagram is two contacts, two conversations and possibly two leads. The "one AI agent, one customer card across all channels" promise needs a person-level identity.

## Revision of the audit recommendation (with the reason)
The 2026-11-10 data model review proposed making `Contact` the person and moving channel identities into a new `ContactIdentity` table. Reading the code for this ADR showed the cost: `Contact` is used as a **channel identity** in 15 places: three intake `contact.upsert` calls keyed by the provider id (`telegram-webhook.service.ts`, two in `instagram-webhook.service.ts`), the inbound processor (`providerUserId` is the send target), the agent context, lead and action services, erasure (ADR 049), scheduling, the contacts list. Changing what `Contact` means touches all of them, and a merge would have to **re-point conversations, leads, bookings and appointments**, which is irreversible in practice.

**Decision: add `Person` above `Contact`; `Contact` stays the per-channel identity.**
- New table `persons`; `contacts.person_id` (nullable at first, then required) points at it. Conversations, leads, bookings and appointments keep pointing at `Contact`: nothing existing moves.
- A **merge is a pointer change**: the contacts of the merged person are re-pointed to the survivor; the merged person row is kept with `merged_into_id`. Undo re-points them back from the audit snapshot. No conversation or lead is touched.
- The customer card, the contacts list and duplicate detection work on `Person`; channel code keeps working on `Contact` unchanged.

## Schema (additive, applied in expand → backfill → switch → contract steps)
- `persons`: `id` uuid(7), `tenant_id`, `display_name` (nullable), `primary_phone` (normalised, nullable), `merged_into_id` (self FK, nullable), `deleted_at`, `created_at/updated_at`; `@@unique([tenantId, id])`, index `[tenantId, primaryPhone]`, index `[tenantId, mergedIntoId]`.
- `contacts.person_id` with composite FK `(tenant_id, person_id)` → `persons (tenant_id, id)`, `ON DELETE RESTRICT`; index `[tenantId, personId]`.
- `person_merges` (audit and undo): `id`, `tenant_id`, `survivor_id`, `merged_id`, `contact_ids` (uuid[] snapshot of the contacts moved), `by_operator_id`, `reason`, `created_at`, `undone_at`.
- Phone normalisation to E.164 reuses `apps/api/src/leads/phone.ts` (including the rule that a number only **heard** in a voice note is never stored: `VOICE_DIGITS_POLICY`).
- All new tables get tenant-isolation RLS policies in the same migration style as ADR 050 (`persons`, `person_merges`).

## Behaviour
1. **Intake (slice A, no visible change):** where a new `Contact` is created, create its `Person` in the same transaction (1:1). Existing contacts get a person from a one-off, idempotent backfill script (`apps/api/src/ops/`), batched, with counts logged. After the backfill the column becomes NOT NULL.
2. **Duplicate suggestions (slice C):** two persons of the same tenant are candidates when they share a normalised phone that the **customer typed** (not heard). Suggestions are shown to operators; **nothing merges automatically** (a wrong merge shows one customer's data to another).
3. **Merge and undo (slice C):** `POST /api/v1/people/:id/merge { intoId, reason }` for ADMIN/OWNER (OPERATOR can suggest, not merge), one transaction, audit event and `person_merges` row; `POST /api/v1/people/:id/unmerge` for the latest merge only. Merging is refused across tenants and when either person is erased.
4. **Read side (slice B):** `GET /api/v1/people` (list, search by name/phone), `GET /api/v1/people/:id` (person + contacts with channel, conversations, leads); the contacts page lists persons with channel badges; the inbox conversation header links to the person.
5. **Erasure (slice D):** erasing a person erases every contact of it through the ADR 049 service, then marks the person `deleted_at`; the existing per-contact erase endpoint stays and erases the contact only (and the person when it was the last contact).

## Out of scope here
Companies (P1.4), tags and custom fields (P1.5), the activity timeline (P1.7), automatic identity matching by name, any change to how channels address the customer.

## Risks and mitigations
| Risk | Mitigation |
|---|---|
| Wrong merge | no auto-merge, role limit, audit snapshot, undo, preview of what moves in the dialog |
| Backfill on large tenants | idempotent, batched by id cursor, resumable; verified counts (contacts = persons before the NOT NULL step) |
| Analytics counting contacts as customers | analytics stay on contacts until slice B switches the contacts list; document in the evidence file |
| Bitrix24 duplicate search uses phone (`crm.duplicate.findbycomm`) | unchanged; leads are still created per contact |

## Verification (per slice)
Unit tests (phone normalisation, candidate selection, merge planning); integration tests on the real database (1:1 creation at intake for Telegram and Instagram, backfill idempotency, merge/undo moves exactly the snapshot contacts and nothing else, cross-tenant refusal, RLS isolation of `persons`); e2e for the contacts list, duplicate banner and merge dialog; axe on the new screens; i18n in uz-Latn, ru, en.

## Slice A status and amendments (2026-11-11)
- Migration `20261118090000_person_identity`: `persons`, nullable `contacts.person_id` with the composite FK, RLS for `persons`. **The initial backfill is a set-based, idempotent SQL statement inside the migration** (every contact without a person gets its own person; `display_name` = contact name, `primary_phone` NULL until phone normalisation), not a separate script. The idempotent TypeScript function `backfillPersons` (`apps/api/src/ops/backfill-persons.ts`, CLI `pnpm ops:backfill-persons [tenantId]`) handles stragglers created afterwards (dev scripts, tests).
- **`person_merges` moved to slice C**; slice A does not create it. `contacts.person_id` stays nullable; the NOT NULL step comes after the stragglers are gone (a later slice).
- Intake (`upsertContactWithPerson`, `apps/api/src/persons/ensure-contact.ts`) keeps the native contact upsert, then creates the person and attaches it with a guarded update (`person_id IS NULL`); if a racing writer won, the new person is deleted in the same transaction, so no orphan person is committed. It also heals person-less contacts on their next message.
- Erasure (ADR 049) clears the person's `display_name` and `primary_phone` in the same transaction and sets `persons.deleted_at` when the last contact of the person is erased (the person copies the contact name, which is personal data).

## Slice B status: People API (2026-11-11)
- `GET /api/v1/people?q=&cursor=&limit=` (limit 1..50, default 20) returns `{ items: PersonItem[], nextCursor }`; `GET /api/v1/people/:id` returns `PersonDetail` (person item plus `contacts`, `conversations` and `leads`, the last two newest first, at most 20 each). Code: `apps/api/src/persons/people.service.ts` (batched reads, no N+1), pure assembly in `person-view.ts`, controller `apps/api/src/webinbox/people.controller.ts`. No schema change.
- Session-guarded, tenant id only from the session principal, readable by every signed-in role (VIEWER included). Invalid query gives 400 `INVALID_QUERY` / `errors.invalidQuery`; unknown, other-tenant, merged, all-erased or malformed id gives 404 `NOT_FOUND` / `errors.notFound`.
- Rules: erased contacts (`deleted_at`) are never read into a result; a person with no non-erased contact, a merged person (`merged_into_id`) and a deleted person are not listed and their detail is 404. `q` is a case-insensitive substring of the person `display_name` or any non-erased contact `name` or `phone`. Order is newest person first by id (uuid v7), `cursor` = id of the last item of the previous page. `phone` is the first non-null phone of the non-erased contacts (oldest contact first); `channels` has one entry per non-erased contact, oldest first; `lastActivityAt` is the newest conversation `updatedAt` over those contacts; `marketingOptOut` is true if any non-erased contact opted out.
- Contacts that still have no person (legacy rows from scripts and tests) are not part of this API. The e2e/dev seed scripts (`scripts/e2e-fixtures.ts`, `src/dev/dev-superadmin.ts`) now call `backfillPersons` after creating contacts so the list is not empty there. `ContactErasureService` needed no change: it already sets the contact `deleted_at` (and the person's when it was the last contact), which removes it from the lists (covered by `people.integration.spec.ts`).
- `GET /api/v1/contacts` and `DELETE /api/v1/contacts/:id` are unchanged.
- **Slice B display name (review fix):** `displayName` is the person's own name and falls back to the oldest contact that has a name, because channel names can arrive after intake (the Instagram name is filled later); until a later slice keeps `persons.display_name` in sync with contact name changes, the API derives it.


## Slices C and D: design and API contract (2026-11-11, accepted by the owner: "P1.1 C/D bosqichlari: shularni qilamiz")
Decisions made while specifying (each is a refinement of the sections above, not a reversal):
- **No auto-merge, ever.** Duplicate candidates are computed on read, never stored. The key is the **last 9 digits** of the digits of a contact `phone` (all stored phones were typed by the customer: `VOICE_DIGITS_POLICY` keeps heard digits out). This is a heuristic for the Uzbek market (`+998 90 123 45 67` and `90 123 45 67` match); two numbers from different countries with the same last 9 digits would be suggested wrongly, which is acceptable because a human decides. A per-tenant default region comes with settings later. No schema column is needed; `persons.primary_phone` stays unused.
- **Candidates** are non-merged, non-deleted persons of one tenant that each have at least one non-erased contact, sharing the key of at least one non-erased contact phone. Phones shorter than 9 digits never match.
- **Merge direction:** `POST /people/:id/merge` merges person `:id` (the **source**) into `intoId` (the **survivor**). The source row is kept with `merged_into_id = intoId`; its contacts (all rows with `person_id = source`, erased ones included) are re-pointed to the survivor. The survivor's own `display_name` is never edited (the slice B fallback to the oldest named contact covers a missing name).
- **Audit and undo:** table `person_merges` (below) is the audit trail; the `audit_events` table also records `person.merged`, `person.unmerged` and `person.erased` (found while building; the draft of this ADR said there was none). `contact_ids` snapshots exactly the contacts moved.
- **Unmerge** is addressed by the **survivor**: `POST /people/:survivorId/unmerge` undoes that survivor's most recent merge that has no `undone_at`. It is refused (409 `UNMERGE_BLOCKED`) when the survivor is itself merged or deleted, when the merged person is no longer pointing at the survivor, or when the merge's contacts include one that is erased. Contacts created on the survivor after the merge stay with the survivor. Only the latest merge of a survivor can be undone, so merges are undone in reverse order.
- **Erasure (slice D)** shares one helper for both entry points: after the contacts are erased, every person row that was merged into the erased person (directly or through a chain) has its `display_name` and `primary_phone` cleared and `deleted_at` set, and every `person_merges.reason` of those merges is replaced by `[erased]`. A merged row is a copy of personal data, so it must go with the person.

### Schema (migration `20261119090000_person_merges`)
`person_merges`: `id` uuid(7), `tenant_id`, `survivor_id`, `merged_id`, `contact_ids uuid[]` not null, `by_operator_id` (FK to operators, `ON DELETE RESTRICT`), `reason varchar(500)` not null, `created_at`, `undone_at` nullable, `undone_by_operator_id` nullable. Composite FKs `(tenant_id, survivor_id)` and `(tenant_id, merged_id)` to `persons (tenant_id, id)` `ON DELETE RESTRICT`; index `(tenant_id, survivor_id, created_at)`; RLS tenant-isolation policy in the ADR 050 style, plus `rls.integration.spec.ts` coverage as for `persons`.

### API (all session-guarded; tenant id only from the session principal)
All error bodies use the existing shape (`{ statusCode, message, code?, errorKey? }` as the slice B controller does).

| Route | Who | Behaviour |
|---|---|---|
| `GET /api/v1/people/:id/duplicates` | any signed-in role | `{ items: PersonItem[] }` (same item shape as the list, at most 10, newest first) of the persons that share a phone key with person `:id`. 404 `NOT_FOUND` when `:id` is unknown, other tenant, merged, deleted or all-erased. |
| `GET /api/v1/people/duplicates` | any signed-in role | `{ groups: { reason: 'PHONE', persons: PersonItem[] }[] }`, at most 50 groups, each with 2..10 persons, groups ordered by the newest person id. Route declared before `:id`. |
| `GET /api/v1/people/:id/merge-preview?intoId=` | ADMIN, OWNER | `{ source: PersonItem, survivor: PersonItem, moves: { contacts, conversations, leads } }` counts of what would be re-pointed (non-erased contacts only). 400 `INVALID_QUERY`, 404 `NOT_FOUND`, 409 `MERGE_REFUSED`. |
| `POST /api/v1/people/:id/merge` body `{ intoId: uuid, reason: string 3..500 }` | ADMIN, OWNER (OPERATOR and VIEWER get 403 `FORBIDDEN`) | Merges `:id` into `intoId` in one transaction; both rows locked `FOR UPDATE` in id order. Returns `{ mergeId, survivor: PersonDetail }`. Errors: 400 `INVALID_BODY` (bad uuid, reason length), 400 `SAME_PERSON`, 404 `NOT_FOUND` (unknown or other-tenant id), 409 `MERGE_REFUSED` (either person merged, deleted, or without a non-erased contact). |
| `POST /api/v1/people/:id/unmerge` (no body) | ADMIN, OWNER | Undoes the survivor `:id`'s latest un-undone merge. Returns `{ mergeId, survivor: PersonDetail, restored: PersonItem }`. 404 `NOT_FOUND` (no such survivor or nothing to undo), 409 `UNMERGE_BLOCKED`. |
| `DELETE /api/v1/people/:id` | OWNER only (403 otherwise) | Slice D. Erases every non-erased contact of the person through the ADR 049 logic **in one transaction** (refactor `ContactErasureService` to expose an in-transaction method; the per-contact endpoint keeps its behaviour), clears the person, and applies the merged-lineage rule above. Returns `{ personId, contacts: number, conversations: number, messagesRedacted: number }`. 404 `NOT_FOUND` for unknown, other-tenant, merged or already erased persons. |

`PersonDetail` (slice B) gains one additive field: `lastMerge: { id: string, mergedAt: string, contacts: number } | null` — the survivor's latest un-undone merge when it can currently be undone (the unmerge preconditions hold), else `null`. List items are unchanged.

### Verification (builder and reviewer)
Unit: phone key (formats, `+998`, brackets, <9 digits), merge planning. Integration on the real database: candidate groups (typed phones across Telegram and Instagram contacts, erased contact excluded, other tenant excluded, merged person excluded), merge moves exactly the snapshot contacts and nothing else, conversations and leads keep their `contactId`, role matrix (OPERATOR/VIEWER 403 on merge, preview and unmerge; all roles read duplicates), cross-tenant ids give 404, concurrent merges of the same source (one wins, other 409), merge then unmerge restores the exact contact set, unmerge blocked cases, erase person (all contacts erased, person cleared, merged rows cleared, `reason` replaced, repeat gives 404, non-OWNER 403, atomic: a failure leaves nothing half erased), RLS test for `person_merges`. E2E is written by the web task.

## Slices C and D status (2026-11-12, branch `feat/p1-1-person-slice-cd`, API only, not merged)
Built as specified: migration `20261119090000_person_merges` (table, composite FKs including `(tenant_id, by_operator_id)` and `(tenant_id, undone_by_operator_id)` to `operators`, index, four RLS policies; RLS covered in `rls.integration.spec.ts`), `GET /people/duplicates` (declared before `:id`), `GET /people/:id/duplicates`, `GET /people/:id/merge-preview`, `POST /people/:id/merge`, `POST /people/:id/unmerge`, `DELETE /people/:id`, and `lastMerge` on `PersonDetail`. Code: pure rules in `apps/api/src/persons/person-merge.ts` (phone key, merge plan, unmerge check, group building), `person-merge.service.ts`, `person-erasure.service.ts`, shared residue helper `person-erasure-residue.ts` (`clearMergedLineage`), controller `webinbox/people.controller.ts`. `ContactErasureService.eraseInTransaction(tx, ...)` holds the in-transaction work; `erase()` wraps it and behaves as before, and calls the residue helper when it erases the last contact of a person.
Implementation notes and minimal deviations:
- Candidates are computed in SQL (`PHONE_KEY_SQL`, the twin of `phoneKey`); the tenant-wide groups are one query (top 50 keys), then one batched item load; per-person candidates are one query plus the batched load. A person holding two different keys can appear in two groups.
- Error bodies use the existing `i18nKey` field (not `errorKey`): new keys `errors.samePerson`, `errors.mergeRefused`, `errors.unmergeBlocked`, `errors.invalidBody` must be added to the web catalogs by the web task.
- `UNMERGE_BLOCKED` also covers a defensive fourth case: a snapshot contact that no longer exists or no longer belongs to the survivor.
- Unmerge reads the latest merge, locks both person rows in id order, re-reads the merge under the lock (a concurrent unmerge that already won gives 409 `UNMERGE_BLOCKED`).
- Person erase writes audit event `person.erased` in addition to one `contact.erased` per contact; merge and unmerge write `person.merged` / `person.unmerged` (ids and counts only, never the reason).
- Preview: unknown or other-tenant ids are 404; merged, deleted or all-erased people are 409 `MERGE_REFUSED`. `moves` counts non-erased contacts of the source.

- **Review addition (slice D):** erasing a contact also clears the copy on a merged-away person row (name, phone, merge `reason`) once every contact of that merge snapshot is erased, even while the survivor has other live contacts (`clearErasedMergeCopies`). Per slice A, any contact erase still clears the person's own `display_name`/`primary_phone`; the name is then derived from the live contacts.
