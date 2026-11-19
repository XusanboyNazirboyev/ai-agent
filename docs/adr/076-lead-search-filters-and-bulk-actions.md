# ADR 076 — Lead search, more filters, per-pipeline counts and bulk actions

Status: accepted (2026-11-19). The owner asked on 2026-11-19, with screenshots of another CRM as a reference, for: search by a customer's name or phone, a few more filters "without it becoming cluttered", lead counts per pipeline and in total, and a **Select** mode to move many leads to another owner or another pipeline at once.

## Context
- The funnel board read its column counts from `GET /pipelines/:id/board`, which only knew the creation-date range. The columns list leads from `GET /leads`, which knew owner, source, close date and tag. A column could say 23 while listing fewer.
- Moving a lead and changing its owner existed one lead at a time (`PATCH /leads/:id/stage`, `PATCH /leads/:id/opportunity`).
- `GET /pipelines` already returned `leadCount` per pipeline (active leads); the web did not show it.

## Decision
- One filter definition (`pipelines/lead-filters.ts`: `LeadFilterQuery` + `leadFilterWhere`) used by both the list and the board, so a count always matches its column. Filters: owner (an id or `none` for unassigned), source, expected close range, tag, creation range (`from`/`to`), `q`, `channel` (the conversation's `channelType`), `score` (HOT/WARM/COLD) and `task` (`none`: no open task; `overdue`: an open task past due).
- `q` matches the contact name (contains, case-insensitive) or, when it holds 3 or more digits, the stored phone containing those digits (phones are stored normalised, so `+998 97 988` finds `+998979887020`). Two digits never search the phone. Tenant-scoped like every lead query.
- The board computes counts and per-currency totals with Prisma `groupBy` on the same `where` instead of raw SQL (amounts still `toFixed(2)` decimal strings). The board query stays strict: an unknown parameter is a 400.
- `POST /api/v1/leads/bulk`, at most 100 lead ids (duplicates collapse):
  - `{ action: 'assign', leadIds, ownerOperatorId | null }`: OWNER and ADMIN only (stricter than the single update, because it changes many leads at once). The owner must be an active operator of the tenant (`FOR SHARE`, as the single update). One transaction; one `lead.opportunity.updated` audit row per lead with `{ fields: 'ownerOperatorId', bulk: true }`.
  - `{ action: 'move', leadIds, stageId, lostReason? }`: any role but VIEWER. The stage is checked once (unknown or archived: 404 for the whole request); then each lead moves through `moveLeadToStage` in its own transaction, exactly as a single move (a stage of another pipeline moves the lead there; LOST needs a reason).
  - Response `{ updated, failed: [{ id, code }] }`: an archived, missing or other tenant's lead, or a move the rules refuse, is reported, not fatal.
- Web: a search box in the leads toolbar (debounced), a **Select** mode with checkboxes on cards and rows and an action bar (change owner, move to a stage of any pipeline), lead counts on the pipeline switcher and the total over all pipelines, and the filters panel grouped into a few compact sections (quick date ranges, channel, owner incl. "mine"/"unassigned", score, tasks).

- The selection survives a search or filter change on purpose, so leads found by separate searches can be moved together; the bar always shows how many are selected, and the dialogs repeat the count. When a later chunk of 100 fails, the dialog shows what the earlier chunks changed next to the error.
- Review follow-ups (2026-11-19): an owner change updates and audits only leads whose owner actually changes; a CSV row refused at create time is reported as skipped instead of failing the whole import.

## Not done
- No "select all matching the filter" beyond the loaded cards; at most 100 leads per request.
- No search in message text or lead summary; no saved filter views.
- Bulk tag, archive or delete.

## Checked
- `lead-search-bulk.integration.spec.ts` (also in the RLS strict list; 6/6 fail when the harness drops the tenant): name and phone search, two-digit query, board counts follow filters, channel/score/unassigned/task filters, unknown board parameter 400, cross-tenant search returns nothing; bulk assign (dedupe, audit rows, unassign, OPERATOR 403, VIEWER 403), bulk move to another pipeline's stage, archived and unknown leads reported, LOST without reason reported and with a reason moved, unknown stage 404, 101 ids 400, another tenant's lead and stage untouched.
