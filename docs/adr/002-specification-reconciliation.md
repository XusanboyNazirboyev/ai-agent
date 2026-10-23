# ADR 002: Reconcile Master Prompt v3 with the optimization addendum

- **Status:** Accepted as implementation guidance
- **Date:** 2026-10-22

## Context

Master Prompt v3 (`AGENTS.md`) remains the product vision, architecture, and roadmap. The accompanying `AGENT_OPTIMIZATION_ADDENDUM.md` explicitly supplies corrected requirements for several unsafe or conflicting v3 details. The repository has completed its foundation migration but has not started persistence or customer-facing automation, so these conflicts can be resolved before they become implementation behavior.

## Decision

Preserve every v3 requirement that does not conflict with the addendum. For explicit conflicts, apply the addendum:

- Customer-visible hard facts use validated, typed, tenant-scoped provenance and code rendering; a global number/date regex is not the primary guardrail.
- Tenant ownership is mandatory on tenant-owned rows and access paths. The Tenant root and justified global immutable records are exceptions that must be documented.
- Phase 2 Telegram is text-only. Voice and image understanding move to later, separately tested work.
- Shared runtime schemas define API/web contracts; connector capabilities and tool arguments/results are validated, and server code controls permissions and side effects.
- Generic REST connectors are constrained adapters with destination, method, redirect, timeout, size, retry, and secret controls.
- Inbound events are durably persisted idempotently before acknowledgment; inbox/outbox or an equivalent mechanism protects queue publication and delivery retries.
- CRM failure is distinct from missing data. Locally accepted leads are persisted and CRM synchronization is retryable; CRM success is reported only after confirmation.
- Consent, data minimization, retention/deletion, source provenance/freshness, and handover reliability are design requirements before the corresponding customer-facing features ship.
- A new vertical that fits the documented capability model should not require changes to stable generic core; genuinely new primitives require a reviewed extension point and ADR.

The addendum's autonomy recommendation does not expand an explicitly audit-only task into an implementation phase. Work proceeds autonomously within the scope the user has actually requested.

## Consequences

- Phase 1 schema work must model tenant-owned data and exact money safely without assuming the first live CRM, locale, currency, or launch project.
- Phase 2 and connector implementations need durable event processing, text-only Telegram scope, typed contracts, and negative security/reliability tests.
- No Open Question is resolved by this ADR. The detailed phase audit and open-question mapping live in `docs/PROGRESS.md`.
- `AGENTS.md` and the addendum remain unchanged; this ADR records how implementation will reconcile them.
