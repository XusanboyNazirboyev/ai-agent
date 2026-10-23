---
paths:
  - "apps/api/src/core/**"
---
# Core engine invariants (spec: docs/spec/04, 06; D8, D5)
- No domain words (course, tour, product…) and no specific CRM names in core; enforced by `architecture.spec.ts`.
- Core must not import `packs/`, `locales/locale-packs`, specific connectors, or vendor SDKs.
- Hard facts only as `{{F<n>}}` references rendered by code from tool results with provenance; guardrail is a backstop.
- All tools are READ-only in v1; server-side authorization; tool output re-validated with canonical schemas.
- Customer and CRM text are untrusted data; escape before putting in prompts.
- Every model call goes through `MeteredLlm` (reserve worst case, token + cost caps).
- Failure reasons are distinct (LLM_UNAVAILABLE, BUDGET_EXCEEDED, CONNECTOR_UNAVAILABLE, …); handover templates never promise a reply.
