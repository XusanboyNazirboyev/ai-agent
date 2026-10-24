# ADR 020 — Web Operator Inbox backend (Phase 6A)

Status: accepted for Phase 6A step 1 (backend). Sources: `docs/spec/10-frontend.md` 12A.2–12A.4, D12, D19, D20, D22.

## Decisions
- **Live Telegram verification is not a prerequisite.** The inbox uses the operator command layer (`HandoverService`), which is covered with mocked transports; nothing in 6A calls Telegram. Phase 6's acceptance is closed (voice deferred by owner decision), so AGENTS rule 10 allows 6A.
- **Login:** email + password per operator (`operator_credentials`, scrypt N=2^16, r=8, p=2, parameters stored with the hash, NFKC-normalized). Email is unique across tenants and resolves the tenant at login; afterwards the tenant always comes from the session row. Unknown emails verify against a dummy hash (no timing/response oracle). 5 failures lock the account for 15 minutes; a per-address limiter (20/min) sits in front. MFA is [OPEN] and not built.
- **Sessions:** random cookie `ac_session` (httpOnly, SameSite=Strict, Path=/, Secure by default; `SESSION_COOKIE_SECURE=false` only for plain-http development and refused in production). Only SHA-256 of the token is stored. 12 h absolute, 2 h idle.
- **CSRF:** per-session token returned by login, stored hashed, required in `X-CSRF-Token` on every non-GET request, plus an `Origin` check against `WEB_ORIGINS`. The web app talks to the API through a same-origin proxy (Next.js rewrites), so no CORS is opened.
- **Commands:** the existing `/api/v1/handovers/*` commands accept either the bearer API token or the session cookie (`OperatorRequestGuard`); the role check (viewers refused), idempotency and audit stay in `HandoverService`.
- **Realtime = database change feed, not an in-process bus.** Triggers on `conversations` (state/assignee change), `messages` (insert) and `handovers` (insert; first SLA alert) write ids-only rows to `inbox_events` in the same transaction, so every writer (webhook intake, agent pipeline, operator commands, SLA scan) is covered and several API processes work. `GET /api/v1/events` (SSE) polls the tenant's rows every second, honors `Last-Event-ID`/`?lastEventId`, sends `resync` when pruned events cannot be replayed, heartbeats every 15 s, and allows 5 streams per operator. Rows are pruned after 24 h by a scheduled scan.
- **Deviation from 12A.2:** `InboxNotifier` is not a push implementation of `OperatorNotifier`; the feed above plays that role without touching the notification service. `OperatorNotifier` stays the Telegram-group port.

## Known limits / not yet built
Web app (`apps/web`), i18n catalogs and key-parity check, Playwright e2e, message-text search, mark-spam, lead-status and slot edits, canned replies, MFA, per-process (not cluster-wide) stream counter, load/soak of SSE polling (1 query/s per open stream).
