# ADR 046: Appointment scheduling engine (skills, availability, buffers) and live booking

- **Status:** Accepted (owner decision 2026-11-09). D-9 is lifted: booking creation is enabled. Step 1 (data model, slot engine, hold/confirm) in progress.
- **Context:** owner Stage 2 asks for "FieldPulse-style" booking: during a chat or call the agent finds a free slot that fits the service and a qualified staff member, confirms it with the customer and creates the job at once. Target: a universal pack for field services, repair/service centres, clinics and other appointment businesses. The existing `bookings` table is offer-based (a seat in a course group) and has no time or staff; it stays for that use.

## Owner decisions (2026-11-09)

1. Slots respect: service duration, travel buffer, preparation/lead time; staff skills/tags; a day-by-day availability matrix per staff member; live confirmation creates the booking.
2. Source of truth is hybrid: AgentCore's database books the slot immediately; the tenant CRM (Bitrix24) is synced asynchronously.
3. `createBooking` / D-9 restriction lifted.

## Design

Generic scheduling vocabulary, no vertical words (rule 1). Lives in `apps/api/src/scheduling/`.

**Data (all tenant-owned, `tenantId` on every row):**

- `ServiceType`: key, title, `durationMinutes`, `bufferBeforeMinutes`, `bufferAfterMinutes` (travel/preparation), `leadTimeMinutes` (minimum notice), `requiredSkills[]`, optional link to a catalog item, active flag.
- `StaffMember`: display name, `skills[]` (tags), timezone (default tenant), active flag. Not an operator account (an operator may be linked later).
- `AvailabilityRule`: staff member, weekday (1–7), local `startTime`/`endTime` (several per day allowed), optional `validFrom`/`validUntil`.
- `AvailabilityException`: staff member, local date range, either unavailable (leave, holiday) or extra hours.
- `Appointment`: service type, staff member, contact, conversation, `startsAt`/`endsAt` (the service itself) and `blockedFrom`/`blockedUntil` (with buffers), status `HELD` → `CONFIRMED` → `CANCELLED`/`COMPLETED`/`EXPIRED`, `holdExpiresAt`, `idempotencyKey`, `crmSyncStatus`, `crmExternalId`.

**No double booking:** a PostgreSQL exclusion constraint (`btree_gist`): no two `HELD`/`CONFIRMED` appointments of one staff member may have overlapping `[blockedFrom, blockedUntil)` ranges. Expired holds are marked `EXPIRED` in the same transaction before an insert. The database, not the application, is the last line of defence.

**Slot engine (pure function, unit-tested):** input = service, staff with skills, rules, exceptions, existing blocked ranges, `now`, a search window and the tenant timezone; output = candidate slots `{ staffId, startsAt, endsAt }` on a fixed grid (default 15 minutes), where the whole blocked range (buffers included) lies inside the staff member's working hours, overlaps nothing, starts at least `leadTime` after `now`, and the staff member has every required skill. Ranking: earliest first, then the least-loaded staff member that day. Times are computed in the staff timezone and stored in UTC.

**Agent flow (D4, D5):** code decides the missing slots (service, preferred day/time); the tools `find_slots` and `book_slot` return facts (`datetime`, staff display name as a title fact); the model only references them. `book_slot` creates a `HELD` appointment (short hold, default 10 minutes) and the existing proposal/confirmation lifecycle (ADR 024) asks the customer to confirm; confirmation makes it `CONFIRMED`. No payments, no discounts (D16).

**CRM sync (hybrid):** on `CONFIRMED`, an outbox job calls the connector's booking write with an idempotency key (ADR 023). A sync failure never cancels the appointment; it is visible to operators (`crmSyncStatus = FAILED`) and retried. The canonical write input gains the time, service and staff fields.

## Owner answers to the open items (2026-11-09, second decision)

- **B1:** a confirmed appointment is written to Bitrix24 as both a deal (stage "Booking Confirmed") and a calendar event. Method names and fields are taken from the official Bitrix24 docs at step 3, and the deal stage is matched by the tenant's configured stage, never invented.
- **B2:** fixed travel buffers per service type for now.
- **B3:** staff and schedules are entered in the AgentCore admin panel first; CRM import later.
- **B4:** the customer may cancel (`cancel_booking`) and reschedule (`reschedule_booking`) through the agent; reminders go out automatically 24 hours and 2 hours before the appointment.

## Steps

1. Schema + migration (with the exclusion constraint), slot engine, hold/confirm/expire service, tests (unit + integration, including concurrent booking of the same slot).
2. Agent tools and confirmation flow; education/clinic-like demo pack data.
3. CRM sync (mock + generic REST first, then Bitrix24 deal + calendar event).
4. Admin UI for services, staff and availability.
5. Cancel / reschedule tools and reminders (24 h and 2 h before).
