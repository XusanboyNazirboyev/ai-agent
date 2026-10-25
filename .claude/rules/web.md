---
paths:
  - "apps/web/**"
---
# Web invariants (spec: docs/spec/10; D19–D22)
- `apps/web` is the Phase 6A operator app: shell with Inbox, Leads and Settings pages (ADR 020, 025); design system in `src/components/ui`, tokens in `globals.css`.
- Layout gate: `e2e/layout.spec.ts` (no horizontal overflow or spilling content, 320–1920px, en/ru/uz-Latn). New pages must pass it.
- Next.js App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query; SSE + REST.
- No hardcoded UI strings (ICU catalogs, CI key-parity); customer messages rendered as plain text only.
- RBAC enforced in the API; secrets write-only in the UI; typed clients from `packages/shared`.
