# ADR 062 — Archiving a lead, then deleting it for good

Status: accepted by the owner on 2026-11-13 ("archive it; a lead can be deleted from the archive, and that delete is permanent"). Builds on ADR 057/058 (pipelines, funnel), 061 (manual leads), 049/052 (erasure of personal data).

## Context
There is no way to remove a lead: a wrongly added manual lead, a test lead or junk stays on the board forever. Erasing a *person* (ADR 052) clears personal data but leaves the lead row. Leads are read in about 30 places (board, list, export, analytics, inbox badges, follow-ups, notifications, CRM sync, person card), so "hidden" must mean hidden everywhere, and "deleted" must not break anything that points at a lead.

## Decisions
1. **Two steps.** A lead is first **archived** (reversible), and only an archived lead can be **deleted for good** (not reversible). Deleting an active lead is refused (409 `LEAD_NOT_ARCHIVED`).
2. **Schema (additive).** `leads.archived_at timestamptz null`, index `(tenant_id, archived_at)`. No other column: who archived and when is in the audit trail.
3. **Archived means out of sight.** Every read that shows leads or counts them excludes `archived_at IS NOT NULL`: the lead list and board counts, pipeline lead counts, CSV export, analytics, inbox lead badges and lead filters, the person card's leads and counts, tag usage counts, follow-ups, handover and alert notifications, CRM sync claiming (an archived lead is not sent; restoring it makes it eligible again). The archive view is the only place that lists them.
4. **Archived leads are frozen for operators.** Move, opportunity, tags, custom fields, hand-back, accept/dismiss a suggestion on an archived lead answer 409 `LEAD_ARCHIVED`. The agent's own scoring of the conversation is not changed (it keeps updating the hidden row); it never un-archives a lead.
5. **API (session guard, tenant from the principal).**
   - `POST /api/v1/leads/:id/archive` and `POST /api/v1/leads/:id/restore`: OWNER, ADMIN. Idempotent (archiving an archived lead returns it unchanged).
   - `GET /api/v1/leads?archived=true`: OWNER, ADMIN; same item shape plus `archivedAt`, paged like the normal list; without the flag archived leads never appear.
   - `DELETE /api/v1/leads/:id`: OWNER only, only for an archived lead; 204.
   - Roles otherwise: 403. Unknown or other-tenant id: 404.
6. **What "delete for good" removes.** In one transaction: the lead's tags, then the lead row. For a lead added by hand (ADR 061) its contact is then erased with the existing contact erasure (ADR 049: personal data cleared, the empty internal conversation closed and left as an invisible shell), so no personal data of a deleted manual lead remains. For an agent-created lead the conversation, messages and contact STAY (they are the customer's history and have their own erasure, ADR 049/052); only the lead row goes, and a later customer message may create a new lead for that conversation.
7. **What it does not do.** It does not delete anything in the connected CRM (no delete call exists in the connector contract); a lead already synced stays there. The UI says so in the delete confirmation.
8. **Audit.** `lead.archived`, `lead.restored`, `lead.deleted`: ids only (lead, pipeline, stage), never name, phone or note.
9. **Web.** Lead panel: "Archive" (confirm). Leads page: a third view "Archive" (OWNER, ADMIN) listing archived leads with "Restore" and "Delete for good"; the delete confirmation says it cannot be undone and that the CRM copy stays. i18n en/ru/uz-Latn, axe, 320px.

   Exception on purpose: the stage and pipeline delete guards still COUNT archived leads (the lead keeps a foreign key to its stage), so a stage that holds only archived leads cannot be deleted until they are deleted for good or restored and moved; the 409 says so.

## Staging of the work
S1 API (migration, archive/restore/delete routes, every read excluded, 409 guards, tests incl. one per read site, mutations, role matrix, RLS unaffected). S2 web (panel button, archive view, confirm dialogs, e2e). S3 release: backup, owner command.

## Risks
A missed read site shows an archived lead somewhere (the S1 test list is built from a grep of every `lead` read, each marked checked or not applicable). Hard delete of a manual lead reuses the existing contact erasure (one audited code path) instead of deleting contact and person rows by hand.

## S1/S2 status (2026-11-13, branch `feat/lead-archive`, built and verified by the reviewing agent)

Built: migration `20261124090000_lead_archive` (`archived_at` + index); `leads/lead-archive.service.ts` (archive, restore, delete for good; audit `lead.archived|restored|deleted` with ids only); routes `POST /leads/:id/archive|restore`, `DELETE /leads/:id`, `GET /leads?archived=true` (OWNER, ADMIN; delete OWNER only); 409 `LEAD_ARCHIVED` / `LEAD_NOT_ARCHIVED`. Excluded from: lead list and board counts, pipeline lead counts, export, analytics, inbox lead badges and lead filters, person card leads and counts, follow-ups, handover and alert notifications, CRM sync (initial and retry), operator score/status routes (the conversation has "no lead"). Web: "Archive" in the lead panel (OWNER, ADMIN, with confirmation), an "Archive" view on the Leads page with Restore (OWNER, ADMIN) and Delete for good (OWNER, confirmation says it cannot be undone and that the CRM copy stays).

Deviations and honest limits:
- Frozen routes answer 409 `LEAD_ARCHIVED` for move, opportunity, tags, custom fields, hand-back, accept/dismiss suggestion. The agent's own scoring of the conversation still updates the hidden row (not changed).
- Tag usage counts, the person-merge preview count and the data-retention check deliberately still count archived leads (a tag with archived leads must not look unused; a contact with an archived lead is not "without leads").
- The raw-SQL branch of the inbox `waiting` scope with a lead score filter carries the filter but has no test; the Prisma branches are tested.
- Hard delete of an agent-created lead keeps the conversation; a later customer message can create a new lead for it.

Tests: integration `webinbox/lead-archive.integration.spec.ts` (9 cases; mutations killed for list filter, board SQL, pipeline counts, export, person card count, inbox filter, delete guard, manual-contact erasure, role check, move guard); e2e `lead-archive.spec.ts`. Related integration specs (27 files, 382 tests) and the lead e2e set (89) pass.
