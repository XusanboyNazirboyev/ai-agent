# ADR 056: CSV export of people and leads (P1.9)

- Status: Accepted
- Date: 2026-11-12

## Context
P1.9 requires exporting people and leads as CSV for bulk review. Exports expose personal data and must respect roles, tenant scope, visibility (no erased/merged-away persons), and avoid leaking values via audit (counts/filters only).

## Decisions
- **Endpoints:** `GET /api/v1/exports/people.csv` and `GET /api/v1/exports/leads.csv` (session-guarded). Controller in `apps/api/src/webinbox/`.
- **Roles:** OWNER and ADMIN only; OPERATOR and VIEWER return 403 `FORBIDDEN`.
- **Audit:** Every export writes an `audit_events` row (`export.people` / `export.leads`) with safe summary (row count and filters, never values).
- **Visibility:** Never export erased contacts (`deleted_at`), merged-away persons, or deleted persons. Same visibility rules as `PeopleService` / the leads list. `tenantId` only from session principal; all queries tenant-scoped.
- **Streaming and limits:** Stream CSV (`Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="people-YYYYMMDD.csv"` / `"leads-YYYYMMDD.csv"`). Read in keyset pages of 500 (no OFFSET, no loading all rows into memory). Refuse more than 50 000 rows with 413 `EXPORT_TOO_LARGE` (page should tell user to narrow by tag). One export at a time per tenant: in-process lock per tenant plus a short Redis `SET NX EX` if Redis lock helper exists in codebase (evaluate before deciding; record choice). 429 `EXPORT_IN_PROGRESS` on second concurrent request.
- **CSV rules (RFC 4180 + safety):** UTF-8 with BOM (`\ufeff`) so Excel opens Cyrillic/Uzbek correctly; `\r\n` line ends; fields containing comma, quote, CR or LF quoted with doubled quotes. Formula injection defence (OWASP CSV Injection): any cell whose first character (after trimming nothing else) is `=`, `+`, `-`, `@`, tab (`\t`) or CR (`\r`) gets neutralised by prefixing a single quote `'` (OWASP CSV Injection guidance; source: https://owasp.org/www-community/attacks/CSV_Injection, read 2026-11-12). Apply to all user-controlled values (names, phones, tag names, custom field values, notes). Numbers/dates written by code are not prefixed by sniffing; a negative number is only legitimate if column type is numeric (format via pure function that knows column type).
- **Columns:**
  - **people:** `person_id`, `name`, `phone`, `channels` (joined by `; `, e.g. `telegram; instagram`), `contacts` (count), `conversations`, `leads`, `last_activity_at` (ISO 8601 UTC), `marketing_opt_out` (true/false), `created_at`, `tags` (names joined by `; `), then one column per ACTIVE person custom field definition in position order (header = definition label, value = stored value; booleans true/false, dates as stored).
  - **leads:** `lead_id`, `person_id`, `contact_name`, `stage`, `score`, `status`, `summary` is NOT exported, `created_at`, `updated_at`, `tags` (names joined by `; `), then ACTIVE lead custom fields the same way.
- **Filters (optional, zod validated, 400 `INVALID_QUERY`):** `q` (people: same substring rule as list), `tagId`, `fieldKey`+`fieldValue` (reuse existing people filter implementation). Leads: also `stage`, `score`.

## Implementation
- Pure CSV writer in `apps/api/src/exports/csv.ts` with exhaustive unit tests (escaping, BOM, injection defence per dangerous first char, only `=`, apostrophe already present, empty/null).
- Row source service pages with keyset and reuses existing read/filter code. 
- Web: "Export CSV" button on People and Leads toolbars for OWNER/ADMIN only, hidden otherwise; downloads via normal link/fetch with session cookie; busy state, success toast, error mapping via `errorKey` for `EXPORT_TOO_LARGE`, `EXPORT_IN_PROGRESS`, `FORBIDDEN` (add keys to en/ru/uz-Latn, parity green). Respects current tag filter/search. 320px safe in ru/uz-Latn. Unit tests with mocks in exact API shapes; e2e spec added but not run.


## Implementation notes (review 2026-11-12)
- **Lock:** the codebase has a Redis `SET NX PX` helper pattern (Instagram OAuth state ledger) but no reusable lock, so `ExportLock` uses an in-process per-tenant map plus Redis `SET NX PX` (10 min TTL, expires on its own), released with a compare-and-delete script in a `finally` (success, error, abort, client disconnect). Redis failure surfaces as a server error, not as 429.
- **Row limit:** `ExportService.rowLimit` (default 50 000) and `pageSize` (500) are instance fields that tests can lower. The count check runs before the first byte (413 JSON); the limit is also enforced while streaming.
- **Errors after the headers:** the status line is already sent, so the connection is destroyed (client sees a failed download, never a complete-looking truncated file). The audit row is written before the last byte; a failed audit fails the download the same way. Client abort stops reading at the next page and writes no audit row.
- **Typed columns:** numbers, booleans and dates written by code are never prefixed; custom field NUMBER/BOOLEAN definitions use typed columns, TEXT/DATE/SELECT values and every header label (custom field labels are user text) are neutralised.
- **Audit summary:** `{ rows, filters }`; `q` is recorded only as `true`, never its text.
- **Visibility:** same as the people list (`visiblePerson`); leads require a live contact whose person (if any) is neither deleted nor merged away. Channels are distinct channel types.
