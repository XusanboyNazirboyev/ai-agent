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
