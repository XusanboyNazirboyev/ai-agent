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

## Step 2 (web app) — additions and changes
- **CSRF for reloads:** login also sets a readable `ac_csrf` cookie (same lifetime, SameSite=Strict, Secure like the session). The page copies it into `X-CSRF-Token`; the server still compares its hash with the session's, so a stolen cookie value alone proves nothing. A reload or a second tab keeps working.
- **SSE scalability:** the per-stream one-query-per-second poll was replaced by one shared poller per process (`InboxEventBus`, two cheap queries per second in total, only while a stream is open). The bus only *wakes* streams; each stream reads its own events from its own cursor in the database, so resume stays exact and no bus/DB race can lose an event. Streams are recycled after `INBOX_STREAM_MAX_MS` (default 15 min, jittered) so proxies never keep a stale connection; the browser reconnects with `Last-Event-ID`. Tested: query count per tick is constant in the number of listeners, delivery is per tenant, resume replays only newer events in order.
- **Client resilience:** EventSource reconnects by itself; after any drop or `resync` the client refetches over REST; if the server refuses the stream (401/429) it polls every 10 s and retries the stream every 15 s. States are visible (`live`, `connecting`, `reconnecting`, `polling`).
- **Web stack:** Next.js 16 App Router (client-rendered inbox), Tailwind 4, TanStack Query, `intl-messageformat` for ICU. `/api/*` is proxied by Next rewrites (same origin, no CORS). CSP, nosniff, no-referrer and frame denial are set; `script-src` still needs `'unsafe-inline'` for Next's bootstrap (nonce-based CSP is a follow-up).
- **Read model additions:** list filters (language, lead score), search by contact name, phone and message text (tenant-scoped, case-insensitive, no trigram index yet), shown offers, quotes and latest slots in the conversation view; `POST /handovers/:id/lead-status` (audited, idempotent, viewers refused).
- **Config:** `API_HOST`, `WEB_ORIGINS`, `SESSION_COOKIE_SECURE` (false refused in production), `INBOX_STREAM_MAX_MS`, `LOGIN_RATE_LIMIT_PER_MINUTE`, `ENV_FILE` (isolated runs).

## Deferred from 12A.4 (not required by the Phase 6A "Done when"; each needs a decision or a prerequisite)
| Item | Why deferred |
|---|---|
| Mark spam | Needs a product policy (does it block the customer, what do operators see) and a schema flag. |
| Slot editing | Must go through the slot engine's validation (D4); a direct edit would bypass it. Slots are shown read-only. |
| MFA | Marked [OPEN] in the spec. |
| Message-text search index | A trigram index needs the `pg_trgm` extension (new prerequisite). Search works, unindexed, bounded by tenant and page size. |
| Channel filter, Meta window/templates | Only Telegram exists until Phase 8. |
| Server-side unread state | Unread markers are per-browser (localStorage); correct enough for one operator per browser. |
| List virtualization | Lists are cursor-paginated (25 per page, "load more"); virtualization is a follow-up if pages grow. |
| Keyboard shortcuts, accessibility audit tooling | Not built; labels, roles and focus order are standard HTML but no automated axe-style check runs. |
| Firefox/WebKit | e2e runs Chromium only. |
| Cluster-wide stream limit | The 5-streams-per-operator counter is per process. |
| Canned replies | Static, per-locale catalog entries; tenant-editable templates belong to the Tenant Admin (Phase 10). |
