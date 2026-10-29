# ADR 030: Correlation ids on every log line and in-app alerts (Phase 7.3)

- **Status:** Accepted for Phase 7.3. The owner approved the plan on 2026-10-28: operator alerts go only to the tenant's Telegram operator group, the default thresholds are 80% of the monthly budget and 5 CRM failures per hour, and the work is one branch with an intermediate merge after parts 1 and 2.
- **Date:** 2026-10-28
- **Inputs:** spec Section 11 (`docs/spec/09-nfr-eval.md`: structured logs with traceId, conversationId, tenantId and language; alerts on error spikes and queue backlog); `docs/PHASE7_PLAN.md` 7.3 (in-app option A: DB-derived metrics, in-process alerts, JSON logs collected by the host).

## Context
- Logs were already one JSON object per line, without customer text, but only the Telegram pipeline's own events carried a `correlationId`. Lines of one request, one queue job or one scan could not be tied together.
- The only alert was the handover SLA alert. Nothing warned when a tenant approached its LLM budget, when CRM lead sync kept failing, or when queues stopped draining.

## Decision
**1. Correlation ids.**
- An `AsyncLocalStorage` log context (`src/observability/log-context.ts`) holds `traceId` and, once known, `tenantId`, `conversationId` and `language`.
- `StructuredLogger` (`src/observability/structured-logger.ts`, moved out of `main.ts`) adds these fields to every line written inside a context.
- The trace id comes from:
  - **HTTP:** the `x-request-id` header when it matches `^[A-Za-z0-9._:-]{8,128}$`, otherwise a new UUID. It is echoed in the response. The session guard adds the tenant.
  - **Telegram queue jobs:** the outbox event id, the same across retries. The job's tenant is added; the agent pipeline adds the conversation and the reply locale.
  - **Catalog sync jobs:** the job id, plus the tenant.
  - **Handover and scheduled scans:** one new id per pass. A pass covers every tenant, so it carries no tenantId.
- Only identifiers are added. Customer and CRM text never are.

**2. Alerts**, as a `ScheduledScan` (`src/observability/alerts.service.ts`), off unless `ALERTS_ENABLED=true`:
- **Operator alerts**, per tenant, queued as outbox event `alert.operator` and delivered by `HandoverNotificationService` to the tenant's Telegram operator group in the tenant's locale (`operator-text.ts`; en, ru, uz-Latn, not native-reviewed):
  - **Budget:** month-to-date LLM spend (`llm_usage_records`, the same UTC month and data the budget ledger uses) has reached `ALERT_BUDGET_PERCENT` (default 80) of `LLM_TENANT_MONTHLY_BUDGET_USD`. Once per tenant and UTC month.
  - **CRM sync:** at least `ALERT_CRM_FAILURES_PER_HOUR` (default 5) leads in `crmSyncStatus=FAILED` updated within the last hour. Once per tenant and UTC hour.
  - The outbox idempotency key (tenant, rule, month or hour) makes repeated and concurrent scans harmless. A tenant without an active operator group gets no alert.
- **Platform alerts**, as `alert.*` log lines (warn or error) for the host to collect; they are not one tenant's business:
  - `alert.outbox_backlog`: a PENDING outbox event has been due for longer than `ALERT_OUTBOX_BACKLOG_MINUTES` (default 10).
  - `alert.failed_turns`: at least `ALERT_FAILED_TURNS_PER_HOUR` (default 20) agent turns FAILED within the last hour.
  - Each is logged at most once per UTC hour per API process.
- "Eval regression on main" (`PHASE7_PLAN.md`) needs no new code: the CI eval gate (`pnpm test:eval`) already fails the run.

## Consequences
- Every log line of a request, job or scan can be grouped by `traceId`. An operator can quote the `x-request-id` of a failed web call.
- Alerts reuse the existing outbox and operator notifier: no new service, table or migration.
- **Not done here:**
  - A trace does not continue from the webhook request into the queue job it creates (the job uses its outbox id).
  - Platform alerts are only log lines; nobody is paged unless the host's log collector alerts on `alert.*`.
  - The two platform defaults (10 minutes, 20 turns) are proposals that still need the owner's confirmation.
- **Tests:**
  - `observability.spec.ts`: context propagation and isolation, logger fields, header rules, the Telegram job and scan-pass traces.
  - `trace-http.spec.ts`: a real Nest HTTP app; it fails without the middleware.
  - `alerts.integration.spec.ts`: fixed clocks; thresholds, once-per-window, tenant isolation, disabled and no-group cases, delivery in en and ru, platform log lines. It was checked with two mutations: a per-scan dedupe key and a count without the tenant filter.

## Alternatives considered
- **OpenTelemetry with a collector, or a hosted APM (`PHASE7_PLAN.md` options B and C):** more moving parts and a vendor decision (Open Question 9). Option A is enough for Phase 7 and keeps them open, because the fields are already the ones those tools use.
- **A dedicated alerts table:** not needed; the outbox already deduplicates and retries.
