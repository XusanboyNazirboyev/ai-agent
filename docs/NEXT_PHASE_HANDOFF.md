# Next phase handoff (from `docs/spec/12-roadmap.md`, 2026-10-24)

Open items first: (1) real-Telegram verification ([evidence](evidence/telegram-live-2026-10-24.md)), (2) deferred voice criterion of Phase 6 ([VOICE_READINESS.md](VOICE_READINESS.md)). Neither blocks the roadmap order, but Phase 5's LIVE mode stays refused until (1) is done and the owner decides.

## Next in roadmap order: Phase 6A — Web Operator Inbox (`apps/web`)
Source: roadmap "Phase 6A", `docs/spec/10-frontend.md` §12A.4, D19, D20, D22. Must be complete before a pilot with more than ~3 operators.
- **Scope:** auth + RBAC + tenant isolation, SSE stream with resume, conversation list/view/actions, `InboxNotifier` (second `OperatorNotifier` implementation), UI i18n with CI key-parity (uz-Latn, ru, en pending confirmation), responsive layout, Playwright e2e.
- **Done when:** operator completes see → take over → reply → return in the browser; two browsers in sync; tenant A cannot reach tenant B (tested); no hardcoded UI strings; e2e green in CI.
- **Reuse:** operator command service and `OperatorTokenGuard` API (`/api/v1/handovers/*`), handover state machine and audit, `OperatorNotifier` interface, per-account `operatorChatId`.
- **Prerequisites/decisions:** operator authentication method (the current API uses hashed operator API tokens; browser sessions are new), UI language list confirmation, hosting/CORS plan (Open Question 9).
- **Sequence:** ADR for auth/session + SSE contract → read endpoints (list/view) with tenant tests → `InboxNotifier` + SSE with resume → web app shell + i18n parity check → actions wired to existing commands → Playwright e2e (flow + isolation) → CI gate.
- **Risks:** `apps/web` is only a placeholder; no Operator rows or credentials exist; tenant isolation must be tested at the HTTP layer.

## After that: Phase 7 (evaluation, observability, universality proof)
100+ eval cases per pack/locale, CI gate, dashboards, cost tracking, second pack with zero `src/core/**` changes. Do not start before 6A acceptance (AGENTS rule 10).
