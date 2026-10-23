---
paths:
  - "apps/api/prisma/**"
---
# Database invariants (spec: docs/spec/08; ADR 003)
- Additive migrations only; never edit an applied migration or delete history; never reset/drop a database.
- Tenant-owned rows carry `tenant_id` with composite tenant FKs/uniques; every query is tenant-scoped.
- Handwritten invariants (partial unique indexes, CHECKs) go in migration SQL after the generated diff.
- After a schema change: `pnpm db:generate`, `pnpm db:test:prepare`, `pnpm db:test:drift` must show no difference.
- Do not run `prisma format` on the whole schema (it reformats everything); edit by hand.
- Integration tests use only the marked `agentcore_test` database.
