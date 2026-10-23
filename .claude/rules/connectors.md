---
paths:
  - "apps/api/src/connectors/**"
---
# Connector invariants (spec: docs/spec/04 §5.2; ADR 006, 007)
- Declare capabilities; methods exist only when the capability is true; a shared conformance suite must pass.
- Validate all input/output with canonical zod schemas; CRM failure is distinct from missing data.
- GenericRest: HTTPS-only STRICT policy, DNS pinning, per-hop redirect re-validation, size/time/retry limits, secret references only.
- Timeouts, bounded retries, circuit breaker; a connector failure never crashes a conversation.
- No non-idempotent write is retried blindly.
