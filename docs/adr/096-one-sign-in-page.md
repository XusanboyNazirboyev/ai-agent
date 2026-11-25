# ADR 096 — One sign-in page; the account decides the panel

Status: **Accepted** 2026-11-25 (Q1 answered: ask once) (owner request: "/login and /console login should be one;
after signing in our panel opens"). Amends the entry point of ADR 047 only.

## Context
ADR 047 keeps two principals apart on purpose: `operator_credentials` + `operator_sessions`
(tenant, cookie `ac_session`) and `platform_admins` + `platform_sessions` (console, cookie
`ac_platform`), each with its own guard, lockout and MFA challenge (ADR 048). Today they also
have two pages: `/login` and `/console/login`.

## Decision
1. Keep both principals, tables, cookies, guards, roles and MFA exactly as they are. A
   platform session still never opens a tenant route and the reverse.
2. One page, `/login`. `/console/login` redirects to it (keeping `next`).
3. One endpoint, `POST /api/v1/auth/sign-in` (same login limiter, Origin/CSRF rules as today):
   - looks the e-mail up in both tables (one cross-table read, privileged as login is today);
   - checks the password against each identity found, in constant work (a dummy hash when an
     identity is absent, so the response time does not reveal which tables hold the e-mail);
   - a failed attempt is recorded only when **no** identity matched, on every identity with
     that e-mail (as a wrong password counts today). A console login therefore never locks a
     tenant account that shares the e-mail, and the reverse;
   - exactly one match: that principal's existing flow runs (MFA challenge or session cookie)
     and the answer says `{ panel: "app" | "console", mfaRequired?, challenge? }`; the MFA step
     posts to that principal's existing `login/mfa` route;
   - both match: see Q1.
4. After sign-in the web opens `/` (tenant app, its role decides the menu as today) or
   `/console` (platform role decides as today). RBAC inside each panel is unchanged.
5. The old `POST /auth/login` and `/platform/auth/login` stay for compatibility and tests.

## Owner decision
- **Q1 (answered 2026-11-25: (a)):** the same e-mail and the same password exist both as a
  console admin and as a business user: the page asks once which panel to open; only the
  chosen principal's flow (MFA or session) then runs, so no second session is created.

## Tests (planned)
Integration: tenant-only, console-only, both (Q1), wrong password counts on both identities
and locks neither early, lockout of one never blocks the other's correct login, MFA on each
side, suspended tenant, inactive admin. e2e: one page in en/ru/uz-Latn at 320 px, console
redirect, axe.
