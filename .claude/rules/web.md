---
paths:
  - "apps/web/**"
---
# Web invariants (spec: docs/spec/10; D19–D22)
- Phase 6A is not started; `apps/web` is a placeholder.
- Next.js App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query; SSE + REST.
- No hardcoded UI strings (ICU catalogs, CI key-parity); customer messages rendered as plain text only.
- RBAC enforced in the API; secrets write-only in the UI; typed clients from `packages/shared`.
