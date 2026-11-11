# Web unit-test gaps (task 007) — 2026-11-11

**Worktree:** `/Users/xusanboynazirboyev/Documents/Projects/ai-agent-web-gaps`  
**Branch:** `test/web-gaps-007` (base `origin/feat/chain-2026-11-11` @ `4adb4fe`)

## 1. Components/pages/lib without a test (before)

Listed are `.ts/.tsx` files under `apps/web/src/components`, `apps/web/src/app`, `apps/web/src/lib` with no adjacent `*.test.ts(x)` in the same folder (and no matching `*.test.ts(x)` basename). Value note per item (role gating / destructive action / form validation / error mapping / money-date formatting / status badges / other).

| File                                                                                                                                                         | Value (why it matters)                                                                             |               Has test before? |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -----------------------------: |
| `app/(app)/analytics/page.tsx`                                                                                                                               | page wiring / route shell                                                                          |                             no |
| `app/(app)/bot/page.tsx`                                                                                                                                     | page wiring                                                                                        |                             no |
| `app/(app)/channels/page.tsx`                                                                                                                                | page wiring                                                                                        |                             no |
| `app/(app)/contacts/page.tsx`                                                                                                                                | page wiring                                                                                        |                             no |
| `app/(app)/crm/page.tsx`                                                                                                                                     | page wiring                                                                                        |                             no |
| `app/(app)/inbox/page.tsx`                                                                                                                                   | page wiring                                                                                        |                             no |
| `app/(app)/knowledge/page.tsx`                                                                                                                               | page wiring                                                                                        |                             no |
| `app/(app)/layout.tsx`                                                                                                                                       | shell/layout gating                                                                                |                             no |
| `app/(app)/leads/page.tsx`                                                                                                                                   | page wiring                                                                                        |                             no |
| `app/(app)/more/page.tsx`                                                                                                                                    | page wiring                                                                                        |                             no |
| `app/(app)/settings/bot/page.tsx`                                                                                                                            | settings route                                                                                     |                             no |
| `app/(app)/settings/channels/page.tsx`                                                                                                                       | settings route                                                                                     |                             no |
| `app/(app)/settings/crm/page.tsx`                                                                                                                            | settings route                                                                                     |                             no |
| `app/(app)/settings/page.tsx`                                                                                                                                | settings index                                                                                     |                             no |
| `app/(app)/settings/pipeline/page.tsx`                                                                                                                       | settings route                                                                                     |                             no |
| `app/(app)/settings/security/page.tsx`                                                                                                                       | **MFA/security settings surface**                                                                  |                             no |
| `app/(app)/settings/subscription/page.tsx`                                                                                                                   | **subscription/billing visibility**                                                                |                             no |
| `app/(app)/settings/team/page.tsx`                                                                                                                           | **team RBAC/destructive actions**                                                                  |                             no |
| `app/console/(admin)/**` pages                                                                                                                               | platform admin actions (suspend/revoke/role), destructive/role-gated                               |                             no |
| `app/console/login/page.tsx`                                                                                                                                 | console auth/MFA flow wiring                                                                       |                             no |
| `app/invite/[token]/page.tsx`                                                                                                                                | invite acceptance wiring                                                                           |                             no |
| `app/login/page.tsx`                                                                                                                                         | login wiring                                                                                       |                             no |
| `components/app-shell.tsx`                                                                                                                                   | navigation, **expired/past-due subscription banner states**                                        |                             no |
| `components/console/console-admins.tsx`                                                                                                                      | destructive/role-gated admin actions                                                               |                             no |
| `components/console/console-audit.tsx`                                                                                                                       | admin audit view                                                                                   |                             no |
| `components/console/console-login.tsx`                                                                                                                       | console login/MFA flow                                                                             |                             no |
| `components/console/console-plans.tsx`                                                                                                                       | admin plan management                                                                              |                             no |
| `components/console/console-security.tsx`                                                                                                                    | **MFA/security**                                                                                   |                             no |
| `components/console/console-tenant.tsx`                                                                                                                      | **suspend tenant, admin actions, destructive confirms**                                            |                             no |
| `components/console/console-tenants.tsx`                                                                                                                     | tenant listing/filters, **suspend actions**                                                        |                             no |
| `components/console/new-customer-dialog.tsx`                                                                                                                 | form validation                                                                                    |                             no |
| `components/console/tenant-billing.tsx`                                                                                                                      | money/date/status display                                                                          |                             no |
| `components/contacts-page.tsx`                                                                                                                               | (replaced by people list in this chain; test exists)                                               | yes (`contacts-page.test.tsx`) |
| `components/invite-accept.tsx`                                                                                                                               | **invite acceptance, form validation, password rules, error mapping**                              |                     no (added) |
| `components/invite-link-box.tsx`                                                                                                                             | invite link display                                                                                |                            yes |
| `components/knowledge-page.tsx`                                                                                                                              | knowledge flows                                                                                    |                             no |
| `components/leads-board.tsx`                                                                                                                                 | lead actions/status                                                                                |                            yes |
| `components/login-form.tsx`                                                                                                                                  | form validation/error mapping                                                                      |                             no |
| `components/mfa.tsx`                                                                                                                                         | **MFA setup/enable, recovery codes shown once, disable/regenerate**                                |                     no (added) |
| `components/security-page.tsx`                                                                                                                               | security settings wiring                                                                           |                             no |
| `components/subscription-page.tsx`                                                                                                                           | **subscription states, money/date formatting, manager gating**                                     |                     no (added) |
| `components/team-page.tsx`                                                                                                                                   | **role-gated controls, role changes, deactivate/reactivate, revoke invite (destructive confirms)** |                     no (added) |
| `components/ui/confirm-dialog.tsx`                                                                                                                           | destructive confirmation primitive                                                                 |                             no |
| `components/ui/reason-dialog.tsx`                                                                                                                            | destructive/action reason capture                                                                  |                             no |
| `lib/facts.ts`, `lib/invite-link.ts`, `lib/live-updates.ts`, `lib/preferences.tsx`, `lib/seen.ts`, `lib/types.ts`, `lib/use-now.ts`, `lib/platform-types.ts` | helpers/hooks/types (lower test value vs. gating/forms/destructive)                                |                             no |

(Full inventory derived from `find apps/web/src/{components,app,lib} -type f \( -name "*.ts" -o -name "*.tsx" \)` excluding tests/specs/e2e/i18n.)

## 2. Tests added (highest value first)

| New test                                | Covers                                                                                                                                                                                                                                             | Notes                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `components/team-page.test.tsx`         | role-gated visibility (`team.managersOnly` for non-manager), member/invite rendering, **role change and invite revoke behind confirmation**, invite creation/link rendering, error path via mocked `api()`                                         | uses `QueryClientProvider`, mocked `useShell`/`useI18n`/`api`/`InviteLinkBox`; no production changes |
| `components/subscription-page.test.tsx` | manager-only gating, current plan/status/period/payment rendering, no-subscription and `SUBSCRIPTION_EXPIRED` banner (`banner.expired`) states                                                                                                     | mocked `api()` and money/date helpers                                                                |
| `components/invite-accept.test.tsx`     | **invite acceptance form validation** (name required for tenant, min password per kind, mismatch), invalid/404 preview state, tenant submit + redirect, platform submit via `platformApi` with stricter min length, API error mapping (`errorKey`) | no production changes                                                                                |
| `components/mfa.test.tsx`               | **MFA setup/enable flow** (start → secret/URI enroll form → enable → recovery codes shown once), code vs recovery toggle submit, regenerate recovery codes, disable (with password when not required)                                              | `MfaSecurityPanel` driven by mocked `MfaCall`; clipboard stubbed                                     |

## 3. Mutation sanity (>=5, part 1; >=6, part 2)

**Part 1 (task 007, re-verified independently by the reviewer for items 1, 3 and 5; the other two were not re-run):**

1. `components/team-page.tsx` — removed manager gate branch → “hidden for non-managers” test failed.
2. `components/subscription-page.tsx` — forced `banner.expired` off / wrong state text path → expired/no-subscription state test failed.
3. `components/invite-accept.tsx` — bypassed password-length check → min-length validation test failed.
4. `components/invite-accept.tsx` — bypassed mismatch check → mismatch validation test failed.
5. `components/mfa.tsx` — stopped showing recovery codes after enable (skipped `setCodes`) → “shows recovery codes once”/enable flow test failed.

**Part 2 (task 008, verified 2026-11-11 in `test-web-gaps-008`, each mutation shown with `git diff --stat`, test failed as expected, then restored with `git checkout -- <file>`):**

1. `components/ui/reason-dialog.tsx` — forced `valid = true` → “blocks submit for short/empty reason…” failed.
2. `components/ui/confirm-dialog.tsx` — cancel button called `onConfirm` → “calls confirm and cancel handlers appropriately” failed.
3. `components/console/console-admins.tsx` — deactivate button called API immediately (skipped confirm target) → “deactivates another admin only after confirmation” failed.
4. `components/console/console-tenant.tsx` — suspend/reactivate called `status.mutate` immediately → “suspend requires reason dialog and calls API only after confirm” failed.
5. `components/console/new-customer-dialog.tsx` — removed required-field validation guard → “validates required fields before submit” failed.
6. `components/app-shell.tsx` (`AccessBanner`) — forced `expired/pastDue = false` → “renders expired banner and subscription link for manager” failed.
7. `components/login-form.tsx` — skipped MFA challenge branch → “shows MFA step only when API asks for it…” failed.

## 3b. Coverage added in task 008 and remaining gaps

**Added (task 008, tests only):**

- `components/ui/confirm-dialog.test.tsx` — confirm/cancel handlers, cancel event does not confirm.
- `components/ui/reason-dialog.test.tsx` — empty/short reason blocked, trimmed valid reason submitted.
- `components/app-shell.test.tsx` — `AccessBanner` healthy/absent, expired (manager link), past-due warning states.
- `components/login-form.test.tsx` — credential submit/redirect, MFA step appears only when API requests it, error mapping.
- `components/console/console-login.test.tsx` — login success/error mapping, MFA code step, enrollment-required + recovery codes flow.
- `components/console/new-customer-dialog.test.tsx` — `slugify`, required-field validation blocks submit, create + invite link, API error mapped.
- `components/console/console-admins.test.tsx` — read-only/support denied (no fetch), deactivate behind confirmation (API only after confirm), invite/link.
- `components/console/console-tenants.test.tsx` — list render, create button hidden for read-only, new-customer dialog open, status filter query.
- `components/console/console-tenant.test.tsx` — status actions hidden for read-only, suspend behind reason dialog (API only after confirmed reason), reactivate action shown for suspended tenant.

**Still not covered / only partial:** `console-tenant` TeamCard invite create/revoke flows (component exists but not exercised in new tests), broader `console-tenants`/`console-admins` edge cases, `security-page` wiring, full `AppShell` integration (only `AccessBanner` covered), `console-plans`/`console-audit`/`console-security`/`tenant-billing`, and other console/app pages listed in section 1.

## 4. Bugs found (not fixed)

None observed; behavior asserted matches current implementation. Any future discrepancy should be recorded here with file/line and a failing/skipped test.

## 5. Checks

`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter @agentcore/web test` run in worktree (see report). No `pnpm test:integration`, no `pnpm test:e2e`, no dev server. i18n catalog parity test remains part of `@agentcore/web test` and must stay passing.
