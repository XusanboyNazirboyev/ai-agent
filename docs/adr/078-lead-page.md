# ADR 078 - Lead page instead of the side sheet

- Status: implemented on `feat/lead-page` (2026-11-19)
- Owner request (2026-11-19): a customer must open as one big page (a new window), with the CRM card to fill in (fields can be added), a responsible operator, and chat / note / task sections.

## Decision
- Route `/leads/<id>` renders `LeadPage`. The board card, its suggestion chip and the list row are real links, so Cmd/Ctrl-click or middle-click opens a new tab; select mode still toggles instead of navigating; drag and drop is unchanged. The side sheet (`LeadPanel`) is removed.
- Left column: stage stepper (shared `LeadStageStepper`, LOST asks for a reason as on the board), responsible operator, "Main information" (the lead custom fields, always open, saved on blur or change; SELECT fields use the definition options), deal, tags, AI block, move to pipeline, archive. OWNER/ADMIN get "Add field", which creates a LEAD `custom_field_defs` row through the existing `POST /api/v1/custom-fields`.
- Right column: tabs Chat (the inbox `ConversationViewPane` with a new `embedded` prop: no back button, no details panel), Notes, Tasks (unchanged `LeadTasks`), History (`LeadTimeline`, `flat`). A hand-added lead has no chat: its default tab is Notes.
- VIEWER and archived leads are read-only; an archived lead shows a banner.
- API: `GET /api/v1/leads/:id` returns the same item as one list element (shared mapping, tenant-scoped, 404 otherwise, archived included). New `GET|POST /api/v1/leads/:id/notes`: internal notes live on the conversation, and the existing note command needs a handover, which a hand-added lead never has. The new endpoint writes the same `internal_notes` table, with an audit event holding only the text length (OWNER/ADMIN/OPERATOR may write).

## Not done
- Playwright e2e specs were updated to the new page but not run locally.
- The old `leads.more*`, `leads.panelClose` i18n keys are now unused (left in place).
- Test ids `lead-panel-stages`, `lead-panel-stage-*`, `lead-panel-ai`, `lead-panel-lost-reason`, `lead-panel-conversation` were kept; the root is `lead-page`.

## Checked
Web: tsc, lint, full vitest suite (63 files, 440 tests). API: tsc, eslint, strict RLS run of `lead-one.integration.spec.ts` (3 tests, incl. cross-tenant 404).
