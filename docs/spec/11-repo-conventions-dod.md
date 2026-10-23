## 13. REPOSITORY CONVENTIONS

pnpm workspace monorepo (D21). If the repository already exists as a single NestJS app, migrate it to this layout in a dedicated, reviewed commit (move files, keep history, keep CI green) before adding `apps/web`.
```
apps/
  api/                  NestJS backend (port 4000)
    src/
      core/             engine only: orchestrator, slots engine, guardrails, state machine, tool loop, scorer
      channels/{telegram,instagram,whatsapp}/
      queue/
      connectors/       interface, conformance tests, mock/, generic-rest/, sheets/, direct-db/, eduflow/, omoncrm/
      packs/            education/, tourism/, retail-electronics/   (config + prompt fragments + eval cases)
      locales/          uz-Latn/, uz-Cyrl/, ru/, en/, (later kaa/, tg/)
      knowledge/  leads/  handover/  operator/  llm/  speech/  eval/  observability/  config/
    prisma/             schema.prisma, migrations, seed.ts
  web/                  Next.js frontend (Operator Inbox, later Admin and Analytics)
    src/app/            routes (App Router)
    src/features/       inbox/, conversations/, leads/, admin/, analytics/
    src/i18n/           UI message catalogs per UI locale
packages/
  shared/               zod schemas, DTO types, enums (HandoverReason, LeadScore, ConversationState), locale IDs
  config/               eslint, tsconfig, prettier presets
eval/cases/
docs/                   PROGRESS.md, adr/, runbooks/, onboarding-guide.md
```
Rules: `apps/api/src/core/**` must not import from `packs/`, `connectors/<specific>`, or contain domain words; packs and connectors are loaded by config/registry (all earlier references to `src/core/**` mean `apps/api/src/core/**`). `apps/web` talks to the API only through typed clients built on `packages/shared` schemas; it never imports API internals. Strict TypeScript; DTO validation at every boundary (zod or class-validator); dependency injection; prompts as versioned files; conventional commits; pnpm only.

---

## 14. DEFINITION OF DONE (every task)

- Code + tests + docs updated; lint and typecheck pass.
- No hardcoded secrets; validated env config.
- Observability added for new flows.
- Edge cases: empty results, timeouts, duplicates, malformed input, Latin/Cyrillic, apostrophe variants, mixed languages.
- No domain/CRM-specific code leaked into `src/core/**`.
- ADR written for design decisions; PROGRESS.md updated; uncertainties listed under Open Questions.

---
