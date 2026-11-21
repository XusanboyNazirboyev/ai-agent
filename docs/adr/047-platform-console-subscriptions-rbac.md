# ADR 047 — Platform console, subscriptions and two-layer RBAC

Status: accepted (owner decision 2026-11-10). Branch `feat/platform-console`. Depends on ADR 025 (which refused a faked superadmin and sketched the correct design) and ADR 020/028 (web session model).

## Context

The owner sells tezda as a subscription: they open an account for each customer business, watch how it is used, and need to see and control each subscription period. Today a tenant and its first OWNER can only be created by a CLI on the server (`create-tenant-owner`), nothing records a subscription, and `TenantStatus.SUSPENDED` exists in the schema but **no code path reads it** (checked 2026-11-10: zero references outside the generated client), so suspension does nothing. Roles inside a tenant (`OWNER | ADMIN | OPERATOR | VIEWER`) are enforced in the API, but there is no way for a tenant OWNER to add or remove team members from the web, and no principal at all above the tenant. The owner left the design to us ("creativity is yours") and asked for RBAC, then Click payments.

## Decision

### 1. A separate platform principal, never a widened tenant query
- New tables `platform_admins` (email, display name, role `PLATFORM_OWNER | PLATFORM_SUPPORT`, scrypt password hash, failed attempts, lock, active flag) and `platform_sessions` (token hash, CSRF hash, expiry, revocation), mirroring `operator_credentials`/`operator_sessions` but **not** related to any tenant.
- Own cookies `ac_platform` and `ac_platform_csrf`, own guard `PlatformSessionGuard`, routes under `/api/v1/platform/**`. A platform session can never call a tenant endpoint and a tenant session can never call a platform endpoint: the two guards read different cookies and different tables.
- `PLATFORM_OWNER` may do everything below; `PLATFORM_SUPPORT` is read-only (lists and details, no writes). Roles are checked in the API on every write, as for tenants (spec 12A.3).
- Bootstrap: `pnpm ops:platform-admin --email … --name … --password-file …` creates the first `PLATFORM_OWNER` exactly like `create-tenant-owner` (random password written once to a 0600 file, never printed). Later admins are invited from the console.
- **Rule 3 exception, explicit and contained:** code under `apps/api/src/platform/**` queries across tenants by design (tenant list, usage per tenant). Nothing outside that directory may import from it, and it never relaxes a tenant-scoped query elsewhere; the tenant modules stay unchanged. A test asserts the import boundary.

### 2. Subscriptions as data the platform controls
- `subscription_plans`: `code` (unique), name, `price_minor` + `currency` (UZS by default; stored as integers, rendered by code), `period_days`, `limits` JSON (`maxOperators`, `maxChannelAccounts`, `monthlyLlmBudgetUsd`, all optional), `is_active`. Prices are **not seeded**: they are an owner decision ([OPEN]) entered in the console.
- `tenant_subscriptions` (history): tenant, plan, `status` `TRIAL | ACTIVE | PAST_DUE | EXPIRED | CANCELED`, `current_period_start/end`, `grace_until`, `canceled_at`, notes. At most one open row (TRIAL/ACTIVE/PAST_DUE) per tenant, enforced by a partial unique index written in the migration SQL.
- `subscription_payments`: tenant, subscription, `provider` `MANUAL | CLICK`, `provider_ref` (unique per provider), `amount_minor`, currency, `status` `PENDING | PAID | FAILED | REFUNDED`, `paid_at`, recorded-by (platform admin for MANUAL), `safe_summary` JSON (never raw provider payloads with personal data). A MANUAL payment is how a cash or bank transfer is recorded today; CLICK rows come from the Click adapter (§5).
- `platform_audit_events`: actor platform admin, action, optional tenant, entity, safe summary. Every console write produces one.

### 3. Enforcement (what a subscription actually does)
`TenantAccessService.check(tenantId)` returns `ok` or one of `SUSPENDED | ARCHIVED | SUBSCRIPTION_EXPIRED`; the answer is cached for 60 s per tenant.
- **Inbound processing** (the shared inbound processor, before the agent runs): `SUSPENDED`/`ARCHIVED` → *amended 2026-11-10 after the API build:* the existing Telegram and Instagram webhooks already refuse new messages of any non-`ACTIVE` tenant (`tenant.status = ACTIVE` in the intake lookup; Telegram answers 503), so nothing new is stored for a suspended tenant; the processor check covers messages queued before the suspension: no agent turn, no reply, one audit event per tenant per day. This is kept (a suspended customer should not accumulate data), not relaxed. `SUBSCRIPTION_EXPIRED` → the bot does not answer (message stored, conversation untouched, an inbox event tells operators), so the customer is not stranded: operators can still reply by hand.
- **Web login** (`POST /api/v1/auth/login`): `SUSPENDED`/`ARCHIVED` → 403 `TENANT_SUSPENDED`; expired subscription → login succeeds and `GET /me` carries `access: { state, periodEnd, graceUntil }` so the app shows a banner. Nothing else on the tenant side is blocked by expiry.
- **Daily scan** (`SubscriptionScanService`, a `ScheduledScan` in `BackgroundModule`): open rows past `current_period_end` → `PAST_DUE` with `grace_until = end + SUBSCRIPTION_GRACE_DAYS` (default 3); past `grace_until` → `EXPIRED`. Each transition is a platform audit event and an inbox event. The scan is idempotent and tested with a fake clock.
- `TRIAL` behaves like `ACTIVE` until its period end. A tenant with no subscription row at all is treated as `SUBSCRIPTION_EXPIRED` **only** when the tenant has `config.billing.required = true` (set by the console on creation); existing tenants without the flag keep working, so the migration changes nothing for them.

### 4. Console API and UI
- `/api/v1/platform/auth/{login,me,logout}`; `tenants` (list with plan, status, period end, this month's conversations, inbound messages and LLM cost from `llm_usage_records`; create = tenant + first OWNER **invite**, no password ever passes through the console), `tenants/:id` (detail, `PATCH` name/status with a reason), `tenants/:id/subscription` (start, change plan, extend, cancel), `tenants/:id/payments` (record MANUAL), `tenants/:id/invites`; `plans` (CRUD, deactivate instead of delete); `admins` (list, invite, deactivate; `PLATFORM_OWNER` only, never the last owner); `audit` (paged).
- Web app: `/console/login`, `/console` (tenants), `/console/tenants/[id]`, `/console/plans`, `/console/admins`, `/console/audit` in their own layout (no tenant nav), tezda brand, light/dark, phone layout, i18n in uz-Latn/ru/en (D22), axe-checked like the rest. The platform session cookie is the only thing that opens these routes.

### 5. Invites instead of passwords, and tenant team management
- `operator_invites`: tenant, e-mail, role, token hash (unique), 72 h expiry, accepted-at, created by (platform admin or tenant operator). `POST /api/v1/auth/invites/:token/accept { displayName, password }` creates the operator and its credential in one transaction, marks the invite accepted and signs the browser in. The plain token appears once, in the console response or the tenant's Team page, as a link to `/invite/[token]`; it is never logged.
- Tenant **Team** page (Settings → Team), OWNER and ADMIN: list operators, invite with a role, change role, deactivate/reactivate, revoke invite. Rules in the API: an ADMIN cannot grant or remove OWNER; the last active OWNER cannot be deactivated or demoted; nobody edits their own role. Plan limit `maxOperators` is checked here.
- Tenant **Subscription** section (Settings): plan, status, period end, grace, payment history, and later the Click "Pay" button.

### 6. Click payments (next slice, blocked on owner inputs)
Click's merchant integration is implemented from the official documentation at docs.click.uz (URL and read date recorded in the amendment when built); nothing about endpoints, fields or signatures is assumed here. Design constraints fixed now: a payment creates a `subscription_payments` row keyed by Click's transaction id (idempotent), a `PAID` payment extends the open subscription by one plan period (or starts one), signatures are verified in code before anything is written, and all Click secrets live in env (`CLICK_*`), never in the database or logs. **[OPEN] blocking the live Click slice:** the owner's Click merchant credentials, plan prices and trial length. The adapter and its tests are built against the documented contract with a fake Click.

### 7. Out of scope in v1
Self-serve signup, card storage, proration, PDF invoices, multi-currency, per-seat billing, a SUPPORT role that can act (only read), deleting tenants (archive only; data retention stays ADR 035 / Q9).

## Consequences
- Suspension and expiry become real, observable and reversible; the owner sees every tenant's state and usage in one place and never handles customer passwords.
- Two principal types and two session tables add surface: both reuse the proven login limiter, scrypt hashing, CSRF and Origin checks; the platform guard is covered by the same kind of integration tests as `SessionGuard` (wrong cookie, cross-type cookie, CSRF, role).
- Cross-tenant reads exist in exactly one module; the import-boundary test keeps them there.
- Migration `20261115090000_platform_console_subscriptions` is additive (new tables, one partial index); no existing row changes.

## Verification
Unit tests for access decisions, scan transitions, invite tokens and role rules; integration tests on the real database for platform login/guard, tenant creation with invite acceptance, suspension and expiry effects on the Telegram processor and on login, team rules; web unit tests for i18n parity; Playwright for console login → create tenant → invite → sign in as the new OWNER, Team page, expired banner, axe on every console screen.

## Amendment (2026-11-17): edit and delete customers from the console
- **Owner request (2026-11-16/17):** edit customers, delete them, and see the actions on the list, not only on the customer page. This reverses "deleting tenants (archive only)" in §7 for the console; data retention policy (ADR 049, Q9) is unchanged for tenants that are kept.
- **Edit:** `PATCH /api/v1/platform/tenants/:id` also takes `defaultLocale` (added to `supportedLocales` when missing), `timezone` (IANA) and `pack` (a Domain Pack id `key@version`); a reason stays required, and the audit summary records each change as from/to (the name only as `renamed`). The slug is not editable: it identifies the tenant in links and scripts.
- **Delete:** `DELETE /api/v1/platform/tenants/:id` with `{ confirmSlug, reason }`, PLATFORM_OWNER only (unsafe method), and only for an `ARCHIVED` tenant (`409 TENANT_NOT_ARCHIVED`; a wrong slug is `409 CONFIRMATION_MISMATCH`). In one transaction with the tenant row locked: every base table with a `tenant_id` column, read from the catalog at delete time, is emptied for that tenant children-first along RESTRICT / NO ACTION keys (`platform/tenant-erasure.ts`); a table without `tenant_id` that would block, or a cycle, refuses before anything is deleted. Then the tenant row goes and `tenant.deleted` is written to the platform audit (slug, reason, row and table counts). Platform audit entries are kept; their tenant reference becomes NULL and `entityId` keeps the tenant id.
- **Telegram:** before the delete, each Telegram bot of the tenant gets `deleteWebhook` (best effort; counted as removed or failed in the response and the audit), so a deleted tenant's bots stop calling the server. Instagram accounts are not unsubscribed: their events then route to no tenant.
- **Not undoable:** there is no soft-delete or grace period; archive is the reversible step, and the UI asks for the slug typed again.
- **Checked:** unit tests for the deletion order; integration tests on the real database (edit with audit, delete refused while active, for SUPPORT and for a wrong slug, then all rows of the tenant gone including a self-referencing person merge, another tenant untouched, audit kept with a NULL tenant); an e2e test for edit, archive and delete in the console.

## Amendment (2026-11-17): password reset links
- **Owner question:** "agar mijoz o'z akkaunt parolini eslay olmasa qanday qaytaradi?" There was no way: no reset, no e-mail, and a new invite to the same address is refused (`EMAIL_TAKEN`).
- **Decision:** a one-time link, made by a person who may manage the account and sent by hand like an invite (no e-mail provider is chosen yet):
  - Console: customer page → Team → "Password link" for any active person (`POST /api/v1/platform/tenants/:id/operators/:operatorId/password-reset`, PLATFORM_OWNER; platform audit `operator.password_reset_issued`).
  - Tenant: Settings → Team, OWNER/ADMIN with the team-change rules (not for yourself, an ADMIN not for an OWNER) (`POST /api/v1/team/operators/:id/password-reset`; tenant audit).
  - Table `operator_password_resets` (additive migration `20261127090000`): token SHA-256 only, 24 h, one use; a new link retires the earlier ones.
  - `/reset/[token]` page: `GET/POST /api/v1/auth/password-resets/:token` (rate limited like invites). Setting the password clears a lockout and revokes every session of that person; it does not sign in, and MFA stays as it was.
- **Not done:** self-service "Forgot password" by e-mail waits for the e-mail provider decision; it would issue the same kind of link.
- **Checked:** integration test of the whole flow (SUPPORT and self refused, earlier link retired, old sessions revoked, old password refused, new one works, link spent, audit on both sides); e2e from the console button to signing in with the new password; `inviteUrl` accepts `/reset/…` paths only on this origin.

## Amendment (2026-11-17): plan limits for channels and the AI budget
- **Gap:** plans stored `maxChannelAccounts` and `monthlyLlmBudgetUsd`, but only `maxOperators` was enforced; the AI budget was the server-wide `LLM_TENANT_MONTHLY_BUDGET_USD` for every tenant, and the console form had no field for it. Owner 2026-11-17: "consoleda kamchiliklar bo'lsa o'zing to'g'irla".
- **Decision:**
  - Limits come from the tenant's open subscription (`TRIAL`, `ACTIVE`, `PAST_DUE`; `access/plan-limits.ts`). No open subscription, or a key missing from the plan, means no limit for that resource, as for operator seats.
  - **Channels:** enabling a Telegram, Instagram or Messenger account (the step that makes it `ACTIVE`) is refused with 409 `CHANNEL_LIMIT` when the tenant already has `maxChannelAccounts` other `ACTIVE` accounts (the manual channel of hand-added leads is not counted). The check runs once before the call to Telegram or Meta, and again with the update under a per-tenant advisory lock, so two enables at once cannot both take the last slot. Re-enabling an account that is already `ACTIVE` is not a new slot. Connecting (saving a token, still `DISABLED`) is not limited. Lowering a plan does not switch off accounts that are already `ACTIVE`; only new enables are refused.
  - **AI budget:** the plan's `monthlyLlmBudgetUsd` is the tenant's monthly cap for agent turns, voice-note transcription and the budget alert; without it the server default `LLM_TENANT_MONTHLY_BUDGET_USD` applies (unset: no cap). The plan value wins in both directions (it may be above or below the server default). `0` means no AI spending: every turn hands over (`BUDGET_EXCEEDED`), operators still answer.
  - **Console:** the plan form has an "AI budget per month, USD" field (empty: server default); the customer page shows active operators, active channels and this month's AI cost against the plan's limits (`limits` in `GET /api/v1/platform/tenants/:id`).
- **Not changed:** TTS metering (parked, ADR 042 voice replies) still reads no tenant budget.
- **Checked:** unit tests of the limit parsing and the budget choice; integration tests: the second Telegram enable is refused before Telegram is called and the account stays `DISABLED`, re-enabling the first is allowed, freeing the slot lets the second in; an agent turn of a tenant whose plan budget is used up hands over with `TENANT_MONTHLY_LIMIT` while the server sets no cap; the console detail returns the limits; e2e: plan form saves all three limits and the customer page shows "2 / 2", "0 / 1" and the budget.

### Amendment (2026-11-21): one included channel

- **Owner decision:** every tenant gets one active Telegram, Instagram or Messenger account. A second account is paid.
- **Decision:** this supersedes the 2026-11-17 missing-limit rule for channels only. No open subscription and `TRIAL` always use `maxChannelAccounts = 1`, even if the trial plan JSON contains a different value. `ACTIVE` and `PAST_DUE` subscriptions use the plan's explicit `maxChannelAccounts`, with a minimum and default of 1. The console and public plan API display this effective default. Plans that sell more than one account must set a value greater than 1 explicitly.
- **Compatibility:** existing active accounts above the effective limit stay active. The existing locked enable path refuses only the next account, so this change needs no migration and does not disconnect customers.
- **Not decided here:** plan prices and how many additional accounts each paid plan includes remain owner-managed console values.
- **Checked:** unit tests cover no subscription, trial, cancelled, active and past-due subscriptions; channel-slot tests cover the first included account and a paid plan granting more; public plan and platform customer integration tests cover the effective default.

## Amendment (2026-11-17): seeing subscriptions that end soon
- **Gap:** the tenant heard about the end of a period only once it was past due; the console list could be filtered only by tenant status.
- **Decision:**
  - Tenant app: OWNER and ADMIN see a "Your subscription ends on …" banner (`data-state="ending-soon"`, `role="status"`) in the last 5 days of a running `TRIAL`/`ACTIVE` period (state `ok`, no grace date). Operators do not see it (they cannot renew). Past the end nothing new is shown until the daily scan moves the row to `PAST_DUE`, which has its own banner. No API change: `GET /me` already carries `periodEnd`.
  - Console list: a second filter "Subscription": ends within 7 days (an open subscription, `PAST_DUE` included, whose period end is at most 7 days away), each status, and no subscription; with a filter the soonest period end comes first. It runs in the browser on the at most 500 rows the list returns.
- **Not done:** a message to the tenant outside the app (Telegram or e-mail) before the end; e-mail waits for a sending domain. (Telegram done 2026-11-18: amendment "reminder" below.)
- **Checked:** unit tests of both rules (`lib/access-notice`, `lib/subscription-filter`).

## Amendment (2026-11-18): reminder outside the app ("reminder")
- **Gap:** the "ends on" banner is seen only by someone who opens the app; e-mail waits for a sending domain.
- **Decision:** the subscription scan queues a reminder to the tenant's Telegram operator group (the same outbox path and delivery as the budget alert, `alert.operator` with kind `SUBSCRIPTION_ENDING`): once when 5 days or less are left (the banner's window) and once on the last day, per period (idempotency key `alert:subscription-ending:<subscription>:<period end>:<stage>`; a scan that first runs inside the window sends only the latest stage; a renewed period is reminded again). Only running `TRIAL`/`ACTIVE` periods of `ACTIVE` tenants with an active channel account that has an operator group. The text names the end date (`DD.MM.YYYY` in the tenant's time zone) and the days left, in the tenant's default language (uz-Latn, ru, en), and asks the owner or an admin to renew. It is not gated by `ALERTS_ENABLED` (it is part of the subscription, not monitoring).
- **Trade-off:** operators in the group see it too (the in-app banner is OWNER/ADMIN only); the group is the only out-of-app channel a tenant has today. A personal message to the owner needs their Telegram account or e-mail.
- **Checked:** unit tests of the stages, repeats, renewal and skipped rows (`subscription-scan.spec.ts`); integration tests on the real database (one reminder for the tenant with a group, none without, filter mutation-checked; delivery text and the Tashkent date across midnight UTC) in `alerts.integration.spec.ts`.

## Amendment (2026-11-19): Overview page

Owner request: "an admin panel for ourselves: all companies, those coming in and leaving, trials, who subscribed and left, total revenue." Done: `GET /api/v1/platform/overview?months=1..24` (default 12; PLATFORM_OWNER and PLATFORM_SUPPORT; strict query) in `src/platform/platform-overview.controller.ts`, page `/console/overview` (first nav item; `/console` stays the customers list, which now reads `?subscription=<state>`), and the customers list shows created date and last customer message (`lastInboundAt`, max over conversations, one grouped query).

### Amendment (2026-11-21): overview KPI drill-down

The five company KPI cards are links to the customer list: all companies, `ACTIVE` paying customers, `TRIAL` customers, trials ending in the next 3 days, and customers churned in the current Asia/Tashkent calendar month. The two time-based filters use the same definitions as the overview totals; when that segment is requested, the platform API marks current-month churn from cancel/expire audit events only when no open subscription exists. Revenue cards remain non-interactive because they are amounts, not company counts.

Everything is a SQL aggregate on the privileged connection. Calendar months use the fixed platform time zone **Asia/Tashkent**. Subscription rows are updated in place (a paid extension turns a TRIAL row ACTIVE; expiry and cancel change the status), so transitions are read from `platform_audit_events`, which the console and the expiry scan write:

- Company state: each tenant's latest subscription row by `created_at`; NONE = no row. Tenant status counts come from `tenants.status`.
- `trialsEndingSoon`: TRIAL rows whose period ends between now and now + 3 days.
- `newCompanies`: tenants created in the month.
- `trialsStarted`: distinct tenants with a `subscription.started` event whose summary status is TRIAL in the month.
- `convertedToPaid`: tenants whose first PAID payment (by `paid_at`) falls in the month and who had a TRIAL start event at or before it. (Not "first ACTIVE row after a TRIAL": rows are mutated, so that is not observable.)
- `churned`: distinct tenants with a `subscription.canceled` or `subscription.expired` event in the month who have no open row (TRIAL, ACTIVE, PAST_DUE) now. As-of-now: a tenant that came back is not counted, also for past months.
- `revenue`: sum of PAID payments by `paid_at` month per currency (REFUNDED and others excluded), as decimal strings rendered by code from minor units; `allTime`, `thisMonth`, `lastMonth` likewise.
- `mrr`: **estimate**: sum over open ACTIVE and PAST_DUE subscriptions of the plan price normalised to 30 days (rounded per plan), per currency.
- `activeCompanies`: tenants with at least one INBOUND message that month. `usageThisMonth`: conversations created, inbound messages, LLM cost, since the Tashkent month start.
- `recent`: the last 10 audit events of tenant created, subscription started, changed, extended, canceled, expired and payment recorded, with tenant id and name only.

Not done: payments by the Click adapter are counted when they are PAID but were not exercised here; churn for tenants deleted later is lost (audit `tenant_id` becomes null). The web e2e step was added but not run in this session. Checked: integration spec (normal and RLS strict; counts as deltas on the shared database, money in a random currency code per run, seeded rows deleted afterwards), unit tests for month and money math, web unit tests.


## Amendment (2026-11-19): deleting a tenant with audit rows
- **Defect (staging 2026-11-19, owner):** deleting an archived tenant answered 500: `audit_events` is append-only (trigger `reject_audit_event_mutation`, phase 1), and every real tenant has audit rows; the erasure's `DELETE FROM audit_events` raised 55000 and the transaction rolled back (nothing was deleted; the tenant had no Telegram bots, so no webhook was touched). The integration test had passed because its tenant had no audit rows.
- **Fix:** migration `20261129120000_audit_events_tenant_erasure` replaces the trigger function: a DELETE passes only for rows whose `tenant_id` equals the transaction-local setting `agentcore.erasing_tenant`, which `eraseTenantData` sets for the tenant it erases; any UPDATE and any other DELETE are still refused. The platform audit log keeps the deletion record as before.
- **Checked:** the delete test now seeds an audit row and proves, before the delete, that a plain delete, a delete under another tenant's erasure setting and an update are refused; after the delete the tenant's audit rows are gone and another tenant's are unchanged (normal and strict runs).


## Amendment (2026-11-20): searchable active plans when creating a customer

Owner approved active plans, newest first, with server search and pagination.
The old dialog filtered the first 200 plans returned by the general console list;
its oldest-first order could hide a newly created plan.

- Add `GET /api/v1/platform/plans/available` under the existing platform-session
  guard. Parameters: `q` (trimmed, max 200, case-insensitive literal name/code
  match), `limit` (default 25, max 100), UUID `cursor`. Return `plans` and
  `nextCursor`; offer active public and private plans, ordered by `createdAt DESC,
  id DESC`. Prices still come from stored plan rows, never UI defaults.
- Use the row ID as the cursor so PostgreSQL compares its full timestamp precision.
  Exclude the anchor ID instead of using `skip: 1`: deactivating the last item of
  the previous page must not skip the next eligible item. Plans are not deleted.
  A new plan inserted ahead of the cursor does not shift later pages.
- The new-customer dialog debounces search by 300 ms and loads further pages on
  request. Preserve the selected plan across searches, including no matching
  results. Show loading, empty and retry states. Keep the optional no-plan choice.
  Customer creation still validates the selected plan on the server.
- No changes to the general plan-management list, tenant billing, schema or pricing.
  The privileged read is documented in the existing ALLOWED entry. UI text is in
  en, ru and uz-Latn; native-speaker review remains open.

Verified in a source copy without `.env`: API/web tsc, formatting and changed-file
lint; 498 web unit tests; 22 API/privileged tests; 18 strict-RLS platform tests; API
build; new Playwright flow with 28 plans (one inactive), pagination, search,
selection preservation and actual customer creation. API tests traverse 205 active
plans with tied timestamps and PostgreSQL microseconds, concurrent insertion and
cursor-plan deactivation; they cover case-insensitive name/code search, literal
wildcards, empty results, session guards and invalid query inputs.

The broader `platform-console.spec.ts` run passed five tests; its customer lifecycle
reached the audit check and failed because the newest event was `payment.recorded`,
not the asserted `tenant.updated` (line 248). Plan selection/customer creation passed.
That audit-order assertion was not changed. No live staging verification or release.
