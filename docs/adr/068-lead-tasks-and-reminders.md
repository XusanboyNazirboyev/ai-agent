# ADR 068: Tasks and reminders on a lead (roadmap P1.6)

Status: accepted 2026-11-15 (roadmap order; no owner question open).

## Decision
- `lead_tasks` (tenant, lead, title up to 200 characters, due time, assignee, creator, done time, announced time); additive migrations `20261125120000` and `20261125120100` (foreign-key names). A task belongs to a lead and goes with it; an operator with tasks cannot be deleted (operators are deactivated, not deleted).
- API: list a lead's tasks (everyone in the workspace), add / change / finish / delete (OWNER, ADMIN, OPERATOR; a VIEWER reads only), and `GET /api/v1/tasks/mine` (the signed-in person's open tasks, optionally up to a time). The adder is the default assignee; another assignee must be an active person of the same workspace.
- Reminder: a scheduled scan announces a task whose time came **once**, as an inbox event `task.due` on the lead's conversation (claimed row by row, so parallel scans announce it once); changing the due time announces it again later. The web refreshes the lists, plays the alert sound if it is on, and shows "A task is due".
- Web: Tasks in the lead panel (visible, above the deal), "My tasks for today" on Today.
- Not in this step: a Telegram message to the operator group (needs a decision on who is notified there), recurring tasks, tasks on a person without a lead.

## Verified
4 integration tests (add, list, finish, delete, default assignee, my tasks; viewer, bad body, foreign assignee and another workspace refused; announced once and again after a new time; three parallel scans announce once), 3 mutations caught (viewer check, claim condition, re-announce on a new time); 1 browser test (add on a lead, overdue mark, on Today, finish).

## Amendment (2026-11-19): Tasks page, reminders before the due time, Telegram and browser notifications

Owner request (2026-11-19): a Tasks section; a task must remind even when tezda is used as a minimal CRM; tasks must reach the businesses in a notification and in the Telegram bot.

Decision:
- **Tasks page** (`/tasks`, in the side rail after Leads; under "More" on phones): segments Overdue / Today / Upcoming / Done with counts, scope Mine / Everyone (everyone in the workspace may read tasks), assignee filter for OWNER/ADMIN, new / edit / delete with the existing role rules (VIEWER reads only), a lead picker that searches as you type. `GET /api/v1/tasks?scope&status&assigneeId&cursor&limit` (strict query, keyset paging by due time) returns rows plus `counts` for the four segments. Overdue = open and past due; today = open and due later today in the tenant time zone; upcoming = open and due after today; the segments do not overlap. Tasks of archived leads are left out. `tasks/mine` is unchanged.
- **Reminder before the due time:** additive migration `20261129090000_lead_task_reminders`: `lead_tasks.remind_at` (nullable) and `inbox_events.task_title` (nullable, for the notification text); the scan index now covers `coalesce(remind_at, due_at)`. Create/update accept `remindBefore` in {0, 15, 60, 1440} minutes (0 or null = at the due time, stored as null). The scan announces when `coalesce(remind_at, due_at) <= now` and not yet announced; changing the due time or the reminder re-arms it (a due-time change keeps the old lead time).
- **Telegram:** when a task is announced, the same transaction that claims it (`notified_at`) queues one `alert.operator` outbox event `TASK_DUE` (idempotency key task id + claim time), only if the tenant has an active channel account with an operator group; the existing alert path sends it in the tenant's default locale (uz, ru, en) with the due time in the tenant time zone. The payload carries the task id only; text is read at send time under the tenant. The card is plain text (no parse mode), so customer and task text cannot inject markup; control characters are replaced by spaces. No group: skipped, counted in the scan log line (`telegramSkippedNoGroup`, no personal data). The message goes to the group, not to a person: who is addressed there is still the assignee's name in the text (a per-person Telegram ping through `telegramUserId` is not done).
- **Browser notification:** `task.due` now carries the task title (title only). On receipt the web shows the toast and sound as before and, when permission is granted and the tab is hidden or unfocused, a system notification; clicking it focuses the window and opens `/tasks`. An "Enable notifications" control (on / blocked / not supported; permission is asked only on a click) sits on the Tasks page and in Settings next to the alert sound. Old events without a title still work. Side fix: `task.due` was missing from the shared SSE event schema, so the stream replaced it with a resync; it is added.

Not done: recurring tasks, per-person Telegram pings, an edit form in the lead panel (edit is on the Tasks page).

Checked: integration specs on the real database (also strict RLS): segments and counts, scope, assignee filter, paging, strict query, archived leads, cross-tenant isolation, time zone day bounds, reminder timing and re-arm, once-per-announcement outbox under parallel scans, message text uz/ru, skipped without a group, other tenant's task never sent; web unit tests for the page, the permission control, the live event parser and the shell.
