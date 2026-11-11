# ADR 052 — Person above Contact: cross-channel customer identity and merge (P1.1)

Status: proposed (design only; no schema or code change in this ADR). Roadmap item P1.1; `docs/audit/2026-11-10/AGENTCORE_DATA_MODEL_REVIEW.md` §3.1; blocker 1 in `AGENTCORE_EXECUTIVE_SUMMARY.md`. Depends on P1.2 (ADR 051, channel-neutral inbound processor) only for file layout, not for behaviour.

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
