# ADR 069: Activity timeline of a lead (roadmap P1.7)

Status: accepted 2026-11-15 (roadmap order; no owner question open).

## Decision

- `GET /api/v1/leads/:leadId/timeline` returns what happened on one lead, newest first: lead created, stage moves (from / to, by whom), deal changes, archiving, tasks added and finished, internal notes, handovers (opened with reason, taken, finished) and the newest 40 messages (120-character plain-text previews). At most 150 entries.
- A **read model built at request time** from records that already exist (`audit_events` for the lead, `lead_tasks`, `internal_notes`, `handovers`, `messages`), not a separate projection table fed by the outbox as the roadmap line suggested. Reason: every source is already written in the same transaction as the change it records (stage moves by the assistant and by operators are both audited in `moveLeadToStage`), so a second copy adds a writer and a way to drift without adding information. A projection table can come later if the read becomes slow; the API shape would not change.
- Everyone in the workspace may read it (a VIEWER too); tenant from the session only; lead, stage and operator lookups are tenant-scoped. Customer and CRM text is returned as plain text and rendered as text.
- Web: a collapsed "History" section at the end of the lead panel; it refreshes when tasks change.
- Not in this step: older history paging, filters by kind, the timeline on a contact without a lead.

## Verified

- Integration (`src/leads/lead-timeline.integration.spec.ts`, real Postgres): merge order and names for every kind, message cap, another tenant gets 404. Mutation: removing the tenant filter from the lead lookup fails the tenant test.
- Web unit (`lib/lead-timeline.test.ts`): every kind reads as words, stage names, handover reason, message author.
- e2e: `lead-tasks.spec.ts` sees "Task added: ..." in the History section; lead and a11y specs pass (59).
