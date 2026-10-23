## 12A. FRONTEND AND OPERATOR EXPERIENCE (apps/web)

### 12A.1 Surfaces and priority
| Surface | Users | Phase |
|---|---|---|
| Telegram operator group (MVP, no frontend) | Operators | 5 |
| **Operator Inbox** (web) | Operators | **6A** |
| Analytics dashboard (read-only) | Owners/managers | 7 |
| **Tenant Admin** (setup, connectors, knowledge, locales, team, eval) | Owners/admins | 10 (earlier minimal pages allowed if onboarding is blocked) |
| Public web chat widget (as a new `web` channel adapter) | Customers | after 9, optional |

### 12A.2 Backend contract for the operator experience
- `OperatorNotifier` interface in `apps/api`: `notifyHandover(handover)`, `notifyReply(conversation, message)`, `notifySlaBreach(handover)`. Implementations: `TelegramGroupNotifier` (Phase 5) and `InboxNotifier` (SSE, Phase 6A). Several may be enabled per tenant. Core engine depends only on the interface.
- Telegram operator group MVP: a handover posts one message with summary, slots, lead score and a "Take over" action; operator replies are relayed to the customer through the normal Channel Sender; state machine (D12) is enforced identically to the web inbox. **Verify the Telegram Bot API capabilities you rely on (inline buttons, reply routing, topics) in the official docs; do not assume.**
- Operator actions are API commands, not UI logic: `take-over`, `reply`, `return-to-bot`, `close`, `add-note`, `update-lead`, `update-slots`. All are idempotent (idempotency-key header), tenant-scoped, role-checked, and written to an **audit log** (who, what, when).
- Take-over must be **atomic**: a conditional update on conversation state/assignee (or optimistic version) so two operators cannot take the same conversation; the loser gets a clear conflict error.
- REST under `/api/v1`, cursor pagination, consistent error shape `{ code, message, i18nKey, details? }`, schemas from `packages/shared`.
- **Realtime = SSE** stream (`GET /api/v1/events`), tenant- and permission-scoped. Events: `conversation.updated`, `message.created`, `handover.created`, `handover.sla_breached`. Support `Last-Event-ID` resume plus REST catch-up; client falls back to polling if the stream drops. Events carry IDs/minimal payload; client refetches via TanStack Query invalidation.

### 12A.3 Roles, auth, security (UI + API)
- Roles: `OWNER/ADMIN`, `OPERATOR`, `VIEWER`. RBAC is enforced **in the API on every endpoint**, never only hidden in the UI. Strict tenant isolation (an operator of tenant A must never see tenant B).
- Auth: session in httpOnly + Secure + SameSite cookies, CSRF protection, login rate limiting, password hashing with a modern algorithm. MFA **[OPEN]**.
- Customer messages are **untrusted**: render as plain text, sanitize/validate links, never `dangerouslySetInnerHTML`; media via short-lived signed URLs; set a Content-Security-Policy; no secrets in the client bundle; no PII in URLs or analytics events.
- Secrets in the admin UI (bot tokens, CRM keys) are write-only: never returned to the browser after saving.

### 12A.4 Operator Inbox requirements (Phase 6A)
- **Conversation list**: default view = `WAITING_OPERATOR` sorted by longest wait; filters (mine, all, closed, channel, language, lead score), unread markers, SLA timer, search by contact name/phone/message text (tenant-scoped, indexed).
- **Conversation view**: unified timeline (customer / bot / operator / system events), delivery status, voice messages with transcript, images; **cards** for what the bot showed (offer, price, `validUntil`, quote ID) so the operator sees exactly what was promised; handover panel (reason code, 3-line summary); slots panel (operator can correct slots); lead score with reason codes; contact info; internal notes (never sent to the customer).
- **Actions**: take over, reply, return to bot, close, change lead status, add note, canned replies/templates, mark spam.
- Channel constraints surface in the UI: if Meta's messaging window is closed, disable free text and offer approved templates only (rules **[OPEN: verify]**).
- Notifications: browser notification + sound for new handovers, unread count in the tab title, SLA warning banner.
- Responsive: fully usable on a phone (operators often work from mobile). Keyboard shortcuts on desktop. Virtualize long conversation lists. Default time zone configurable per tenant (default Asia/Tashkent **[confirm]**).
- Operator copilot (suggested reply drafts, clearly labeled as drafts) is Phase 10, not before.

### 12A.5 Tenant Admin (Phase 10; minimal pages earlier only if onboarding is blocked)
Pack selection; connector setup with **test connection** and field-mapping wizard; knowledge upload with ingestion status; locale/tone settings; handover and SLA thresholds; channel connection (Telegram bot token now, Meta later); eval run and results; team and roles; audit log viewer.

### 12A.6 Analytics (Phase 7, read-only)
Date-range dashboards for Section 11 metrics: first-response time, auto-resolved rate, handover rate by reason, lead capture rate and score distribution, language mix, guardrail block rate, cost per conversation. Per tenant. Charts must be accessible (labels, not color-only).

### 12A.7 UI internationalization (D22)
- Message catalogs per UI locale (ICU format) under `apps/web/src/i18n/`. No hardcoded user-facing strings.
- **CI check**: every key exists in every UI locale; missing keys fail the build.
- Locale-aware date, number and currency formatting. Operator UI language is independent of customer languages. RTL is not required.

### 12A.8 Frontend quality gates
- Stack per D20: Next.js App Router, TypeScript strict, Tailwind, shadcn/ui (or equivalent accessible components), TanStack Query; forms with `react-hook-form` + zod schemas from `packages/shared`.
- Every screen has loading, empty and error states. Optimistic updates only for safe actions (notes, assignment) with rollback.
- Tests: component tests (Vitest + Testing Library); **Playwright e2e** for the core flow (login → see handover → take over → reply → return to bot), SSE reconnect, and **tenant isolation**; basic accessibility checks (WCAG AA essentials: contrast, focus, labels).
- Performance budget: inbox list interactive quickly on mid-range phones; no unbounded lists; images lazy-loaded.

### 12A.9 Out of scope for v1
Customer-facing portal, public web chat widget, native mobile apps.

---
