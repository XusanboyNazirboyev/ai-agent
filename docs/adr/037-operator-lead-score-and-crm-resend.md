# ADR 037: Operator-set lead score, and leads kept local reach a CRM connected later

- **Status:** Accepted, 2026-11-04 (owner chose both on staging).
- **Context:**
  - Lead scores are computed by deterministic rules with reason codes (D13). An operator who learns more on the phone could not change the score; the next customer turn would have overwritten it anyway.
  - A lead created while no CRM could take it is marked `NOT_REQUIRED` and kept local. When a CRM was connected later, those leads were never sent (seen on staging: a Bitrix24 portal connected at 05:35, the lead from 04:06 stayed local).

## Decision
- **Operator score:**
  - `POST /api/v1/handovers/:id/lead-score` with `{ "score": "HOT" | "WARM" | "COLD" | null }`, through the existing operator command path (idempotency key, audit `operator.set_lead_score`, roles that may operate).
  - A set score is stored with `leads.score_set_by_operator = true` (additive migration `20261109090000`). Rescoring keeps that level while still accumulating reason codes (the evidence), and the summary says "(operator)".
  - `null` returns the lead to automatic scoring from the next customer turn.
  - A change is queued for the CRM unless the lead is already synced (Bitrix24 has no lead update today).
- **Leads kept local:**
  - `POST /api/v1/handovers/:id/lead-crm-sync` sends a `NOT_REQUIRED` lead again (status `PENDING`, one outbox event). Failed and uncertain writes keep their own retry and resolution paths, so they are refused (`NOT_RESENDABLE`).
  - Connecting Bitrix24 from the web queues every `NOT_REQUIRED` lead of the tenant (`requeueLocalLeads`, at most 500, newest first); the audit event records how many.
- **Web:** the lead box shows whether the score is automatic or set by an operator, a score selector with "Automatic", and "Send to CRM" for a lead kept local.

## Consequences
- An operator's judgement is not silently overwritten; the reason codes still show what the customer did.
- Leads collected before a CRM existed are not lost to it.
- **Checked:** integration tests (score kept through rescoring and released by `null`, audit count, outbox events; resend only for `NOT_REQUIRED`, once; requeue on connect), API unit suite, schema drift check, e2e (operator flow, a11y, CRM connect).

## Amendment 1 (2026-11-04): lead board moves
- **Owner request:** move a lead on the leads page by dragging it, both between score columns and between status columns.
- **API:** `PUT /api/v1/leads/conversations/:conversationId/score` (`{ "score": "HOT" | "WARM" | "COLD" | null }`) and `.../status` (`{ "status": "NEW" | "IN_PROGRESS" | "WON" | "LOST" }`). Keyed by conversation, so a lead whose conversation was never handed over can be moved too. OWNER, ADMIN and OPERATOR only; session and CSRF guard; tenant-scoped; audited with `via: lead_board`. The score and the hand-over command share one helper (`leads/lead-operator.ts`).
- **List:** the inbox list takes `leadStatus` as a filter and returns `leadStatus` and `leadScoreSetByOperator`.
- **Web:** the leads page switches between "By score" (3 columns) and "By status" (4 columns). A card moves by HTML drag and drop or by its "Move to" menu (keyboard and phones). Viewers see the board without move controls.
- **Checked:** integration tests (moves without a hand-over, list filters, audit, viewer 403, another tenant 404), e2e (menu and drag in both views, viewer), API unit suite.
