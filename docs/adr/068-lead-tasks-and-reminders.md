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
