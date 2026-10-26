# EduFlow (Learnix) CRM connector — plan (no code)

Status: **plan only**, 2026-10-26. No connector code, no live call to any Learnix server was made. Inputs: the owner's facts, and the saved contract `openapi.json` (this folder).

## Contract source
- **File:** `openapi.json` here is a copy of the owner's saved file. Source SHA-256 `b752c598…7457fe`, copy SHA-256 `c3018371…a7f21`.
- **One change:** two example `password` values in student-credential examples are replaced with `<redacted-example>`. They looked like possibly real credentials. *Owner: please check whether they are live passwords and rotate them if so.*
- Swagger UI is not exposed on the server (`/api/docs` returns 404), so this file **is** the contract.
- Facts from the file: OpenAPI 3.0.0, title "Learnix API", **157 paths**, 70 schemas. `servers` is `/` ("Joriy server"), so no host is embedded. Security scheme: an `accessToken` cookie.

## Facts used (owner, plus the contract)
- **Auth:** httpOnly cookie sessions; `POST /api/auth/login` (`LoginDto {identifier, password}`), `/api/auth/refresh`, `/api/auth/logout`. There is no API key.
- **Roles and branches:** roles SUPERADMIN/ADMIN/TEACHER/STUDENT, plus staff-role permissions (`GET /api/staff-roles/catalog`). The branch is selected with the `x-branch-id` header, which every operation declares.
- **Response shape:** wrapper `{success, data}`; lists `{items, meta}`. Dates are ISO UTC; the centre's timezone is Asia/Tashkent.
- **Targets:**
  - The base URL is configurable through `EDUFLOW_BASE_URL`; nothing is hardcoded.
  - **Staging** is the deployed Learnix server, which holds test data only. Lead writes are allowed there only after owner approval.
  - **Production** is strictly read-only with a dedicated restricted account, until the owner approves writes.
  - The EduFlow dev server runs on `:4000`, so when both run locally the agent API must use another port (for example `API_PORT=4200`).

## Gaps found in the contract (blocking or important)
| # | Gap | Effect | Ask Learnix / mitigation |
|---|---|---|---|
| G1 | **No 200 response schemas.** All list/get endpoints document errors only. The components have **no `Course`, `Group`, `Lead`** entity schemas, only input DTOs. | Field names and types of responses are unknown from the contract | Record real responses from staging (test data) as fixtures and type them with Zod in the connector. Ask for documented response DTOs. |
| G2 | **Price has no currency.** `CreateCourseDto.price: number`; price exists only on the course, not per group. | D1/D5: a price without a currency cannot be shown | Currency from `GET /api/settings/public` if present (*unverified*), otherwise tenant config (UZS) with owner confirmation. Ask for `currency` and an optional group price. |
| G3 | **No seats left.** Groups have `maxStudent` (capacity) only. The enrolled count is not documented, and the group detail may include **student lists (personal data)**. | Availability cannot be computed without reading student data | Ask for `enrolledCount`/`seatsLeft` on the group (or a public catalog endpoint). Until then the connector does not offer availability, and never reads or stores student lists. |
| G4 | **Start date** exists (`CreateGroupDto.startDate`), plus a weekly schedule (`ScheduleItemDto`: weekDay, startTime, endTime, roomId). | OK for the offer's `startsAt` and a schedule text | Confirm the response field names in the fixtures. |
| G5 | **No language of instruction, level, or online/offline format** on the course or group. | The education pack's `level`/`format`/language slots cannot be matched | Ask for `language`, `level`, `format`. Until then map from the course name/description only as non-fact text, never as a filterable fact. |
| G6 | **No trial-slot resource.** Trial = `POST /api/leads/{id}/trial {groupId, trialAt}`. Possible slots would have to be derived from lessons (`GET /api/lessons?groupId&from&to`). | A "book a trial" action needs slot rules | Later slice. Ask whether any lesson of a group is valid for a trial, and about capacity per lesson. |
| G7 | **`POST /api/leads` requires `leads.manage`**, which also covers update/delete/convert/status. There is no create-only permission. | Least privilege is impossible for writes | Ask for `leads.create`. |
| G8 | **No idempotency on lead create** (no `Idempotency-Key`, no external reference field). `GET /api/leads?search=` semantics are undocumented. | A lost response could create a duplicate lead (ADR 023) | Connector `writeIdempotency: 'lookup'`: search by normalized phone, and recognise our record by a marker in `sourceDetail` (for example `agentcore:<proposal id>`). The search semantics must be verified on staging. Ask for an `Idempotency-Key` or `externalRef`. |
| G9 | **Role-only guards on sensitive endpoints** (documented): `DELETE /api/students/{id}`, `PATCH /api/students/{id}/restore`, `POST /api/payments/{id}/void`, `GET /api/reports/financial`, `/api/uploads/*`, `/api/documents`, `/api/activity/*`, `GET /api/users/staff-options` need only the **ADMIN role**. `GET /api/exports/leads` (CSV of all leads) needs only `leads.view`. | An ADMIN-based agent account could reach forbidden data and actions even with a restricted staff role | **Server-side boundary needed** (see "Access" below). The connector's deny-by-default allow-list is mandatory regardless. |

## Tool allow-list (connector-side, deny by default)
The HTTP client accepts **only** these method + path templates; anything else throws before a request is made. `x-branch-id` is always set from tenant config.

| Use | Method and path | Permission (documented) |
|---|---|---|
| Courses (catalog items) | `GET /api/courses`, `GET /api/courses/{id}` | none stated (roles incl. ADMIN) |
| Groups (offers: start date, schedule, capacity) | `GET /api/groups`, `GET /api/groups/{id}` | `groups.view` |
| Lessons (schedule; later trial slots) | `GET /api/lessons` | `groups.view` |
| Rooms (location text only) | `GET /api/rooms`, `GET /api/rooms/{id}` | none stated (ADMIN) |
| Teachers (display name only, optional) | `GET /api/teachers`, `GET /api/teachers/{id}` | `teachers.view` |
| Branches | `GET /api/branches` | none stated (ADMIN) |
| Public settings (currency, contacts if present) | `GET /api/settings/public` | none stated |
| Lead duplicate check | `GET /api/leads?search=<phone>` (and `GET /api/leads/{id}`) | `leads.view` |
| Lead create (business action, ADR 024) | `POST /api/leads` | `leads.manage` (G7) |
| Later: trial booking | `POST /api/leads/{id}/trial` | `leads.manage` |
| Session | `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout` | — |

**Never called** (rejected by the client, covered by tests): `students`, `payments`, `parent`, `users`, `audit`, `exports` (including `exports/leads`), `reports`, and also `enrollments`, `invoices`, `refunds`, `analytics`, `dashboard`, `documents`, `uploads`, `activity`, `notifications`, `staff-roles` (except an optional manual catalog check), `settings` (non-public), and every non-GET method except the two lead writes.

**Response hygiene:** only whitelisted fields are kept from each response (course: id, name, description, price, status, durations; group: id, name, courseId, startDate, maxStudent, schedules, branchId, status). Student, parent and payment fields, if present, are dropped before mapping and never logged or stored.

## Mapping to the canonical model
- **Course → `CatalogItem`** (title = name, description; attributes: durationMonth, durationHours).
- **Group → `Offer`**:
  - price from the course plus a currency source (G2);
  - `startsAt` = startDate;
  - schedule text from `schedules`;
  - `availabilityStatus` is **unknown** until G3 is resolved: no seat facts are shown;
  - `pricingBasis` per person (*to confirm with the owner*).
- **Lead (create) ← `LeadInput`**: firstName (from contact name), phone (normalized E.164), `source: TELEGRAM` (or INSTAGRAM later), `sourceDetail` = marker, courseId when known, `note` = code-rendered summary of the confirmed proposal (ADR 024; no free model text). branchId comes from config.
- **Times**: parse as ISO UTC and render in Asia/Tashkent.

## Access: dedicated "AI Agent" principal
**Proposed staff role "AI Agent"** (with today's permission catalog):
- `groups.view`
- `leads.view`
- `leads.manage`, **only on staging and only after write approval**; on production none, i.e. read-only
- optional `teachers.view` (only if teacher names are shown; recommended: **not** granted)
- Nothing else: no `students.*`, `finance.*`, `payments.*`, `reports.view`, `audit.view`, `staff.*`, `settings.manage`, `courses.manage`, `rooms.manage`, `branches.manage`.

**Not sufficient on its own (G9).** Because several sensitive endpoints are guarded by the ADMIN role alone, and `exports/leads` by `leads.view`, a staff role on an ADMIN user does not stop them. Ask Learnix, in order of preference:
1. **An integration principal with an API key (recommended).**
   - A non-browser token (an `Authorization` header) issued per integration, with explicit scopes: `catalog.read`, `leads.read`, `leads.create`, later `leads.trial`.
   - Revocable and rotatable, IP-restricted if possible, and audited as "AI Agent".
   - It avoids cookie handling, CSRF and refresh rotation in server-to-server calls, and keeps the agent out of the ADMIN role entirely.
2. Otherwise **a new non-ADMIN role (e.g. `INTEGRATION`)** that the role-only endpoints do not accept, plus a `leads.create` permission (G7) and a guard that excludes it from `exports/*`.
3. Interim, staging only: a dedicated ADMIN-role user with the staff role above, the connector allow-list, and a monitored audit log. **Not acceptable for production.**

## Configuration and secrets
- `EDUFLOW_BASE_URL` per tenant connector (ADR 007 config contract).
  - HTTPS is **required** except for `localhost`/`127.0.0.1`.
  - The host is allow-listed, the redirect policy is "none", and the existing outbound guards (ADR 006) apply.
- Credentials (login identifier and password, or a future API key) live only as a `secretRef` (`.env` / secret store), are never logged and never put in fixtures.
- `x-branch-id` (branch per tenant) is set in tenant connector config.

## Two targets
| Target | Purpose | Allowed |
|---|---|---|
| **Staging** = the deployed Learnix server with test data | Development, recording fixtures, contract tests | Reads. **Lead writes only after owner approval**, with a test marker in `sourceDetail` and cleanup by the owner |
| **Production** | A real centre later | **Read-only** with the restricted principal. **No lead writes** until the owner approves. Connector tests that create leads **never** run against production: the test runner refuses unless the target is labelled staging |

## Testing
- **CI uses recorded fixtures only** (no live calls).
  - Fixtures are recorded from staging with a scrub step: names and phones replaced, no student or payment fields, no cookies or headers.
  - They run through the existing connector conformance suite (`connectors/testing/conformance.ts`).
- **Allow-list tests:**
  - every forbidden family and method is rejected before any request;
  - non-HTTPS non-localhost base URLs are rejected;
  - a production label forbids writes.
- **Contract drift check (manual):** recompute the `openapi.json` hash and diff paths and DTOs when the owner supplies a new file.
- **Staging live checks**, owner-run and opt-in: read the catalog for one branch; lead create only after write approval.

## Order of work (after approval, each a small slice)
1. **Read-only connector** for courses and groups, plus the currency source, plus fixtures (gaps G1, G2 and G5 as known limits). Agent offers: course, price (once a currency source is confirmed), start date and schedule. No seats.
2. **Lead duplicate check + create** (`lookup` idempotency, G8) on **staging** behind the ADR 024 action flow, after write approval.
3. **Trial booking** (G6) once Learnix answers the slot questions.

## Questions for the owner / Learnix team
1. Can Learnix add an **integration API key with scopes**, or at least a non-ADMIN `INTEGRATION` role plus `leads.create`? (G7, G9)
2. Currency of `price`, and is it per student per month/course? (G2)
3. Can groups expose `seatsLeft`/`enrolledCount` without student data? (G3)
4. Language/level/format fields on courses or groups? (G5)
5. `GET /api/leads?search=`: which fields does it match (phone? normalized?), and can a lead carry an external reference? (G8)
6. The branch id(s) to use per tenant.

## Addendum 2026-10-26 (plan only)
Re-read from the saved contract. The owner's source file is unchanged (sha256 `b752c598…`). The Learnix server holds test data only and is the **staging** target. Swagger is not exposed there, so this file is the contract.

### Schema inspection: Course, Group, Lead
`components.schemas` (70 schemas) has **no `Course`, `Group` or `Lead` response schema**, and the list/get endpoints document their 200 responses with no body (G1). The only shapes are the request DTOs:

| DTO | Fields (`*` = required) |
|---|---|
| `CreateCourseDto` | `name*`, `description`, `price*` (number), `durationMonth*`, `durationHours*`, `status` (ACTIVE/INACTIVE) |
| `CreateGroupDto` | `name*`, `courseId*` (**string**), `description`, `teacherId`, `studentIds`, `startDate*`, `maxStudent*`, `schedules*` (`ScheduleItemDto`: `weekDay*`, `startTime*`, `endTime`, `roomId`), `branchId` (number) |
| `CreateLeadDto` | `firstName*`, `lastName`, `phone*`, `parentPhone`, `source` (TELEGRAM, INSTAGRAM, …), `sourceDetail`, `courseId` (**number**), `assignedToId`, `nextContactAt`, `note`, `branchId` (number) |
| `ScheduleTrialDto` | `groupId*` (**number**), `trialAt*` |

Lists take `page` and `limit` (not offset or cursor), plus filters (`status`, `search`, `courseId` on groups). Every operation documents the `x-branch-id` header.

| Need | Contract | Status |
|---|---|---|
| Price | `course.price`: a number with no currency, per course, not per group | G2: currency from `settings/public` (to confirm), basis unknown |
| Seats / capacity | `group.maxStudent` only; no enrolled count | G3: **seats left unknown**, so availability is not shown |
| Start date | `group.startDate` plus weekly `schedules` | Usable, if the response matches the DTO (G1) |
| Language / level / format | none | G5: education-pack slots cannot be matched |
| Trial slots | none; trial = `POST /api/leads/{id}/trial {groupId, trialAt}` | G6: free times would have to be derived from lessons or schedules |
| **G10 (new): ID types** | `courseId` is a string on groups but a number on leads; `groupId` and `branchId` are numbers | Confirm the real ID type from recorded responses before mapping |

### Capability flags (first slice)
| Flag | Value | Why |
|---|---|---|
| `sync` | true | `GET /api/courses` and `GET /api/groups` (paged) |
| `search` | true | `search` query parameter on courses and groups (matching rules to confirm) |
| `liveQuote` | **false** | No quote endpoint; only a listed course price |
| `availability` | **false** | No seats-left value (G3) |
| `createLead` | true on **staging only after write approval**; false on production | `POST /api/leads` (`leads.manage`, G7) |
| `updateLead`, `createBooking`, `webhooks` | false | Not in scope; trial booking (`createBooking`) comes later, after G6 |

Consequence: with `liveQuote` and `availability` false, the display gate (ADR 013) accepts listed facts. So the `FACT_NOT_LIVE` failure that dominates the Groq baseline on the mock connector does not arise for EduFlow. It still needs a currency for any price (G2), and it must never show seats.

### GenericRestConnector or a bespoke connector
`GenericRestConnector` on `main` supports `none`/`bearer`/`apiKey`/`basic` authentication, `offset`/`cursor`/`none` pagination and a `dataPath`. Learnix needs three things it lacks:
1. **Cookie session authentication**: `POST /api/auth/login`, then httpOnly cookies, then `POST /api/auth/refresh` with the refresh-token cookie, and re-login on expiry.
2. **Page-based pagination** (`page` + `limit`, with totals in `meta`).
3. **A fixed `x-branch-id` header** on every call.

`{success, data: {items, meta}}` fits `dataPath: data.items`.

**Recommendation: a thin bespoke `EduFlowConnector`** in `connectors/eduflow/` (not in `core/`), reusing the existing `http-client`, SSRF protection, DNS pinning, resilience, field mapping and write idempotency from `generic-rest/`.
- The session cookie jar and refresh rotation are stateful and specific to Learnix; adding them to the shared generic connector would widen a security-sensitive component for one CRM.
- If Learnix issues an **API key with scopes** (question 1), switch to `GenericRestConnector`, plus two small generic additions (page pagination and fixed headers) that also help other CRMs.
- Owner decision.

### Conformance and contract tests (CI = recorded fixtures only)
- **Fixtures:** recorded once from staging with an authorized test account. Names and phones are scrubbed; no student, parent or payment fields are kept. They are served by a local fake HTTP server, with no network in CI.
- **Existing suite:** `connectors/testing/conformance.ts` against the fake server, covering sync, search, lead create and errors.
- **Allow-list:** every non-allow-listed method and path throws *before* a request is made. A table test covers each forbidden prefix: students, payments, parents, users, audit, exports, reports and the rest of the never-called list.
- **Session:** login sets cookies; an expired access token triggers refresh and one retry; a failed refresh triggers one re-login, then `CONNECTOR_AUTH`. Credentials never reach logs or errors.
- **Transport:** `x-branch-id` is on every request; HTTPS is required except for `localhost`; `EDUFLOW_BASE_URL` comes from configuration only.
- **Mapping:** course to `CatalogItem` and group to `Offer` (start date, schedule text, no seat facts); prices refused without a currency; the ID types from G10.
- **Lead:** duplicate check by normalized phone, then create once; a retry after a lost response does not duplicate (G8, ADR 023 operation records).
- **Response hygiene:** fields not on the whitelist are dropped, which a fixture containing extra sensitive fields proves.

### Permission catalog: pending source access
The permissions above come from the OpenAPI descriptions:
- `groups.view` covers groups and lessons;
- `leads.view`;
- `leads.manage`, for create and trial;
- `teachers.view`, optional.

Courses, rooms, branches and `settings/public` state roles but no permission. **To list the exact permissions the "AI Agent" role needs, read-only access to the Learnix backend source (the eduFlow folder) is required.** Its location and access have not been granted yet. Until then the list is unverified.

## Owner decisions (2026-10-26; still plan only, no connector code)
1. **Thin dedicated `EduFlowConnector` now**, implementing only the existing connector contract (`CrmConnector` and its capability flags), so that it can later be swapped for `GenericRestConnector` with an API key without touching core, packs or tools. No EduFlow-specific types cross that boundary.
2. **All IDs normalized to strings at the mapping boundary** (G10): course, group, branch, lead and lesson IDs, whether Learnix sends a number or a string. Tests: number and string inputs map to the same string ID; the outbound DTOs convert back to the type each Learnix endpoint expects (for example a numeric `groupId` for the trial and a numeric `courseId` for a lead), as confirmed by recorded responses.
3. **Price currency is never guessed.** It comes only from owner-declared connector config (for example `currency: "UZS"` in tenant connector config), with provenance "owner config". If it is absent, a price is shown without a currency claim; it is never inferred from locale, amount or `settings/public` unless the owner declares that as the source. Tests: no currency configured means no currency in the fact; configured means the currency carries owner-config provenance.
4. **No claims about seats left, language of instruction or trial slots** (G3, G5, G6). A customer's trial request becomes a **lead whose note holds the preferred time**, plus a handover to an operator. No `POST /api/leads/{id}/trial` until the trial gaps are answered.
5. **Permission names stay unverified** until the owner supplies the real Learnix permission catalog.
6. **Writes (lead create) only on the staging server, and only after the owner's explicit approval.** Production is read-only.
