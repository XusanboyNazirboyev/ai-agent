# Staff-level repository audit (2026-11-05)

Scope: `main` at `522517d`. Method: static reading, `git grep`, `pnpm audit --prod` and the numbers from this project's own runs. **Not done:** no penetration test, no load test, no browser accessibility measurement, integration and e2e tests not run (the review sandbox cannot run `prisma generate`; CI is the authority). Findings marked *unverified* are inferences. Nothing here was changed in the code.

Size: API 307 TypeScript files / 69k lines; web 76 files / 8.7k lines; tests: 87 unit spec files, 36 integration, 19 e2e files, 170 mock-eval cases in CI.

## 1. Security (Senior Security Engineer)
| # | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| S1 | High | 5 advisories in production dependencies: `body-parser` 2.3.0 (fix >=2.4.0, on the JSON request path), `multer` 2.4.0 (fix >=2.5.0; no `FileInterceptor` found in the API, so probably not reachable, *unverified*), `mysql2` and `deepmerge-ts` (via the Prisma CLI, build-time). CI has no audit step. | `pnpm audit --prod`, 2026-11-05; installed versions from `node_modules/.pnpm` | Bump the packages; add `pnpm audit --prod --audit-level=high` to CI |
| S2 | High | No HTTP hardening: `main.ts` sets no security headers (helmet), no CORS policy, no explicit body-size limit and no inbound rate limit. The "throttle" code found is for outbound clients. Login has lockout (`session.service.ts`). Webhooks are public endpoints. | `apps/api/src/main.ts` (24 lines) | Headers, CORS allow-list, body limit, per-IP and per-account limits on `/webhooks/*` and `/auth/*` |
| S3 | Med | Webhook-secret rotation is not built (slice 1c); owner rule 2026-10-28 says no LIVE before it. The owner allowed LIVE on a local test bot on 2026-10-31. | `docs/TELEGRAM_DEV_RUNBOOK.md` | Build 1c before any real customer |
| S4 | Med | The Dockerfile runs as root, with `CMD pnpm dev`, one stage, no `HEALTHCHECK`. If it is only a dev image this is fine; there is no production image (*unverified* intent). | `Dockerfile` | Multi-stage production image, non-root user, healthcheck |
| S5 | Low | `enableShutdownHooks` is not called, so `OnModuleDestroy` of the queue runtimes is not guaranteed to run on SIGTERM. | `main.ts`; hooks in `telegram-queue.runtime.ts`, `catalog-sync.queue.ts` | `app.enableShutdownHooks()` + test |
| S6 | Med | Tenant isolation is by convention. 295 query calls, 810 `tenantId` mentions; several id-only lookups exist after a tenant-scoped claim (`telegram-agent-pipeline.ts` 331, 558, 584, 752; `instagram-webhook.service.ts` 142) and one credential lookup by account id (`telegram-credentials.ts` 36). Not shown to be exploitable. | `git grep "where: { id"` | A test or lint rule that fails on id-only `where` outside an allow-list |

Strengths (verified in code): scrypt N=2^16 passwords, lockout, double-submit CSRF with `SameSite=Strict`, AES-256-GCM secret store, constant-time compares for webhook secrets and Meta signatures, tagged-template SQL only (no `Unsafe` variants), no secret-like strings in tracked files (pattern scan, 0 hits; only `.env.example` is tracked).

## 2. Backend (Senior Backend Engineer)
Strengths: per-conversation advisory locks, idempotency keys, outbox and lease/claim turn model, budget ledger, additive migrations.
- B1 (Med) `agent_turns` does not store intent, extraction failure or draft failure, so a FALLBACK in production cannot be explained from the database (found while debugging a real Telegram turn on 2026-10-31). Add an additive migration.
- B2 (Med) Open defects: DEF-013 (a failed Bitrix24 comment after lead creation is not retried), DEF-015 (lead routing is a stopgap: oldest connector that can create leads), DEF-008 (BullMQ tests fail while the dev API shares Redis; use a separate Redis DB or key prefix in tests).
- B3 (Low) Only one `/health` route; no readiness check for Postgres/Redis.

## 3. Frontend (Senior Frontend Engineer)
Stack: Next 16, React 19, Tailwind 4, TanStack Query. i18n key parity is exact: 504 keys in each of en, ru, uz-Latn.
- F1 (Low, real) The Bot page names accounts through `NAMES = { telegram: 'Telegram' }` with a fallback to the raw channel type, so an Instagram account is shown as "instagram" (`bot-page.tsx` lines 25 and 131).
- F2 (Med, UX) Mode is chosen on the Bot page, but the Instagram card on the Channels page offers only enable and disable, and a connected Instagram account starts in OFF, where it sends nothing. A first-time owner has no hint that a second step is needed. Show the mode and a link on the Channels card.
- F3 (not measured) Accessibility and performance were not measured.

## 4. QA / SDET
Strengths: no skipped or `.only` tests; lint, typecheck, unit, integration, mock eval, coverage, format, build and e2e all run in CI; an architecture spec guards "no vertical words in core".
- Q1 (Med) Coverage is measured but has no threshold, so it is not a gate.
- Q2 (Med) One job runs every step in sequence (about 9 minutes); no parallel jobs, no dependency audit, no scheduled live eval.
- Q3 (Low) Flakiness history: DEF-008, DEF-018 (fixed), one e2e timeout on `bot-knowledge.spec.ts:199`; DEF-020: a spec depends on the developer's `.env`.
- Q4 Missing: recorded real Meta and Telegram payload fixtures (contract tests), a webhook load test, guardrail mutation tests.

## 5. AI systems and performance
Measured on `gemini-3.8-flash` (paid, 2026-10-30/31), fictional English cases only:
| Run | Pass | Structured valid | p50 / p95 | Notes |
|---|---|---|---|---|
| 200-token cap | 5/15 | 60% | 3.3 s / 6.8 s | All 10 failures were truncated model output (thinking tokens share the cap) |
| 1024-token cap (the app's cap) | 7/15 | 100% | 13.2 s / 20.4 s | 0 hard-fact violations shipped; 4 cases ended as BUDGET_EXCEEDED; 3 drafts still truncated; cost $0.039 / 15 cases |
Real Telegram turn (LIVE, test bot): outcome FALLBACK, 5 model calls, about 27 s from message to reply.
- A1 (High) Latency and fallbacks make the bot feel broken. Candidate fixes: `reasoning_effort` pass-through (documented by Google as low/medium/high; being added), fewer calls per turn, a typing indicator, a tuned turn budget (default $0.02 is hit by worst-case reservation at a 1024 cap; the exact limit is measured by `LIVE_EVAL_TURN_BUDGET_USD`).
- A2 (High) Only 15 English cases were run live. No live evidence for uz-Latn, uz-Cyrl or ru, and native-speaker review is still pending (D18). Language claims are unproven.
- A3 (Med) Safety design is sound (facts only from tools, rendered by code); injection resisted in one case, which is a very small sample.

## 6. Product (sales, support, leads)
- P1 (High) Without an ACTIVE connector that can search, every ordinary question ends as NO_DATA (`agent-turn.ts`). Knowledge/FAQ does not open that gate, so a small shop without a CRM cannot get answers. The only catalog today is the fictional mock; Bitrix24 is a lead sink only (create lead). Decision needed: a knowledge-first path for non-price questions (touches D1/D2) and a real read connector.
- P2 (High) Channels: Telegram and Instagram DM exist. No Instagram comments, Messenger or WhatsApp. Serving other businesses on Instagram needs Meta Advanced Access (App Review + Business Verification); the owner has no company documents yet.
- P3 (Med) Handover works by state machine, but no operator group is configured by default, so a handover can wait with nobody told.
- P4 Unit cost is low: about $0.0026 per eval case at list price (expires 2026-12-31).
- P5 (Med) Time to first value for a new tenant: connecting a bot is easy in the web UI; getting data in is not (connectors are created by scripts, no admin screen).

## Priorities
P0 (before any real customer): S2, S1, S3, A1, P1 decision. P1 (next two weeks): A2 with native review, B1, F2, S6 guard, Q1/Q2, P3. P2: S4/S5, B2, Q4, Instagram comments.
