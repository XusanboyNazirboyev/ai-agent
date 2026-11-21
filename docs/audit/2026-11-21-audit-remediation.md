# Audit remediation 2026-11-21 (local, not committed)

Branch `feat/ui-words-menu` at `f25658d` (clean before this work). `origin/main` is 752 commits behind it and 95 ahead (diverged); staging builds `feat/production-pilot`. Owner rules for this pass: local code and tests only; no commit, push, deploy, workflow run or staging command. (The Gemini Flash-Lite switch and the two plans were done on staging before this pass, at the owner's request.)

## Status per finding
| Finding | Status | Evidence |
|---|---|---|
| P0.1 branch protection / security features | Confirmed | `docs/audit/2026-11-21-repo-security-posture.md`: 97 branches, 0 protected, no rulesets, Dependabot, secret scanning and code scanning off; public repository |
| AUD-10 title facts | Partially fixed before, completed here | Dates, times and prices without a currency were not checked; a number repeated by the model from such a title counted as sourced |
| AUD-04 Instagram atomicity | Already fixed, validated | `instagram-connect.integration.spec.ts` 31/31 (atomic connect, failed reconnect, parallel callbacks, no secret echo); no log call in the controller |
| AUD-06 graceful shutdown | Partially fixed, one gap closed | Hooks run in order (workers, queues, timers, Redis; then HTTP close; then pools) and are idempotent. Gap found: open SSE streams (up to 15 min) kept the HTTP close waiting until the container was killed, before the pools closed. `EventsController.beforeApplicationShutdown` now ends them (new test, called twice; fails without the fix). Untested: SIGTERM during an active BullMQ job, Redis close, a forced timeout |
| AUD-07 image identity | Needs evidence | Image tag = first 7 chars of the SHA (mutable), label `org.opencontainers.image.revision` = full SHA; deploy pulls by tag, not digest; the running app reports no commit |
| AUD-12 SSE validation | Already fixed, test added | `parseLiveEvent` validates every payload; malformed JSON and bad payloads refetch; new hook test |
| RLS strict readiness | Evidence below | |
| AUD-01, AUD-02, AUD-11 | Already fixed, validated | specs pass (3/3, 501-message regression, 2/2) |
| AUD-08 | Validated | pause/drain test and a new slow-client disconnect test (3,000 queued events, about 390 KB) pass; it fails with the bound raised |

## Changes
- `apps/api/src/core/agent/guardrails.ts`: `titleHardFact()` adds dates (day plus month name in uz-Latn, uz-Cyrl, ru, en; `dd.mm`, ISO dates), times (`18:00`) and prices without a currency (thousand groups, 5+ digits, "150 ming", "1,2 mln", "300k") to the currency and availability checks. Referenced titles get the matching violation. Unsafe titles no longer count as a source for numbers in the model's own text. "mart"/"may" count only whole or with a date suffix, so "1 martalik", "maydon" and "майки" stay allowed.
- Tests: `agent-components.spec.ts` (15 hard-fact titles, 10 ordinary titles, referenced date title, price repeated from an unsafe title, number from a safe title), `agent-policy.spec.ts` (fallback drops date and price titles), `apps/web/src/lib/live-updates.test.ts` (malformed JSON and bad payload refetch, unknown type not listened to, later valid event handled).
- Mutation checks: with the old `guardrails.ts`, 18 of the new tests fail; without the refetch on a bad payload, the new hook test fails.

## Verification (local)
- API: typecheck, lint of changed files, format check pass; `agent-components` and `agent-policy` 101/101; agent-related integration specs alone (telegram-agent, action-eval, telegram, signup, rls-background) 191/191.
- Full local `vitest run` of the API: 9 to 10 files fail and the set changes between runs (digest, alerts, live-eval key, catalog-sync Redis and shared-database leftovers); the agent specs among them pass when run alone. Not run: the strict RLS suite and e2e for this change (the guardrail change touches no database access).
- Web: typecheck, format, 512/512 unit tests.

## RLS strict readiness (recommendation only)
Staging runs the app role in `warn` since 2026-11-20: after the public-plans fix (`3d37e12`) its log showed 0 `db.tenant_context_missing` and 0 errors. The strict suite now covers every integration spec except 12 documented infrastructure and owner-CLI specs (`16833c7`), 85 of 86 files locally (the known catalog-sync Redis wait). Switch to `strict` when: (1) seven days of staging logs show no `db.tenant_context_missing`, including daily scans (digest, retention, subscription expiry); (2) the strict suite is green in CI on the release commit; (3) a backup is checked first; (4) rollback is `RLS_CONTEXT_MODE=warn` in `deploy/.env.api` and recreating the api container.

## Open
AUD-06 lifecycle tests; AUD-07 deploy by digest and a build-info endpoint (owner decision); GitHub settings in the posture document (owner, GitHub UI); AUD-10 on `main` (only the merger session merges to `main`; this fix lives on `feat/ui-words-menu`).
