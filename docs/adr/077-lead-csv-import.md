# ADR 077 — CSV import of leads

Status: accepted (owner request 2026-11-19).

## Context
- Tenants move to the product with a customer list in a spreadsheet; adding leads one by one (ADR 061) does not scale.

## Decision
- The browser parses the file (`lib/csv-parse.ts`: RFC 4180, BOM, `,` `;` or tab detected from the header line, headers mapped to `name|phone|source|amount|currency|note` by uz/ru/en synonyms). The user can fix the mapping and picks an OPEN stage of the current pipeline (`LeadsImportDialog`). The file is limited to 2 MB, UTF-8.
- `POST /api/v1/leads/import` (OWNER/ADMIN, like the CSV export) takes `{ pipelineId, stageId?, rows }` with 1 to 200 rows; the client sends longer files in sequential chunks. The server trusts nothing from the client: every row goes through `parseManualLeadBody` (the manual lead rules) and then `ManualLeadService.create`, one transaction per row. A source missing from a row becomes `import`.
- Skipped rows are reported as `{ row, code }` (0-based index in the request): `INVALID_VALUE` for a row the manual rules reject, `DUPLICATE` when the phone key (last 9 digits, `phoneKey`) already belongs to a contact with an active (not archived) lead in the same pipeline, or appeared earlier in the same request. Rows without a phone are never duplicates. A duplicate across two chunks is caught by the database check, because the first chunk is already stored.
- One tenant audit event `lead.imported` per request with counts only (rows, created, skipped, stage id); never a name, phone or note. Each created lead also keeps its own `lead.created_manually` event.

## Consequences
- No new table or migration; reuses the manual lead path, so contacts link to the existing person by phone (ADR 052) and RLS applies as for any request.
- Not atomic: a failure after some chunks keeps the leads already created; the dialog shows what was created and the error.
- The amount and currency columns are mapped only when the web shows the amount (`LEAD_AMOUNT_ENABLED`, off by owner decision 2026-11-13); the API accepts them.
- Large files (thousands of rows) mean many requests; acceptable for the 2 MB limit, a background job was not needed.
