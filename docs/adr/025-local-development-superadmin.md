# ADR 025 — Local development "Superadmin" and dev-only CSP exception

Status: **implemented** on `phase6a/web-operator-inbox` (2026-10-24).

## Context
A developer needs a login for the web inbox on a local database. The data model has **no platform-level role**: every `Operator` belongs to exactly one tenant, roles are `OWNER | ADMIN | OPERATOR | VIEWER` and every query is tenant-scoped (rule 3). A "superadmin who sees all tenants" does not exist and must not be faked by a bypass.

## Decision
- `pnpm dev:superadmin [--demo] [--reset-password]` (`apps/api/scripts/dev-superadmin.ts`, logic in `src/dev/dev-superadmin.ts`) creates **one** `OWNER` operator "Local Superadmin" (`superadmin@agentcore.local`) in **one** dedicated tenant (`dev-local-superadmin`, fake data). It is the strongest role the model has, scoped to that tenant: no access to any other tenant, no code path treats it specially.
- Guards: `NODE_ENV=development` and a localhost database (`assertLocalDevelopment`); the credential file must lie outside the repository; production is refused by the same guard.
- Idempotent: tenant, operator and credential exist once; an existing credential is never changed unless `--reset-password`. `--demo` adds three fictional conversations only if the tenant has none.
- Password: 24 random characters (`crypto.randomBytes`), stored only as an scrypt hash (the existing `hashPassword`, N=2^16). The plaintext is written once to `~/.config/agentcore/dev-superadmin.password` (directory 0700, file 0600; override the directory with `AGENTCORE_DEV_SECRETS_DIR`) and is never printed, logged or committed. Obtain it with `pbcopy < ~/.config/agentcore/dev-superadmin.password`.
- Tests: unit (generation, permissions, repository-path refusal, guard) and integration (one operator/credential after repeated runs, OWNER, hash is scrypt and rotates on reset, demo data once).

## A real platform superadmin (not built)
If cross-tenant administration is ever needed, the smallest correct design is a separate `PlatformAdmin` principal (own table, own session cookie and audience, not an `Operator`), whose actions go through explicit, audited, per-tenant "support access" grants with expiry, never through widening tenant queries. That needs its own ADR, threat model and owner decision; nothing here prepares or bypasses it.

## Dev-only CSP exception (web)
Under `next dev`, Next's overlay creates `<style>` elements without a nonce. The production policy (`style-src 'self' 'nonce-…'`) refuses them, which broke the overlay and produced one console error per element. In development only (`NODE_ENV !== 'production'`, the same condition that already adds `'unsafe-eval'` for React's dev build) `style-src` is `'self' 'unsafe-inline'` (no nonce next to it, because browsers ignore `'unsafe-inline'` when a nonce is present). Scripts stay nonce-only in every mode. The production build keeps the nonce-only policy and the e2e tests assert zero violations and the absence of `'unsafe-inline'` there. `src/csp.test.ts` pins both policies.
