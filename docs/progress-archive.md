# Progress archive (audit and phase history)

Moved from `docs/PROGRESS.md` on 2026-10-24; the current state is at the top of `docs/PROGRESS.md`.

## Specification basis

- `AGENTS.md` is Master Prompt v3 and remains the product and roadmap source of truth.
- `AGENT_OPTIMIZATION_ADDENDUM.md` is supplemental. Its explicit corrections override only conflicting v3 rules; compatible v3 requirements remain in force. Neither specification file was modified.
- The addendum narrows delivery toward one text-only, end-to-end vertical slice and adds concrete safety, provenance, tenant-isolation, durable-event, privacy, and connector requirements. It does not authorize rebuilding working code or skipping roadmap gates.
- **2026-10-23:** `AGENT_OPTIMIZATION_ADDENDUM.md` and `AGENT.md` are not present in this checkout or its git history. The addendum's corrections are known here only through [ADR 002](adr/002-specification-reconciliation.md) and this file; restore the original file if it should remain the authoritative text.

## Specification understanding

- **Locked decisions (v3 §3):** trusted tools supply facts and typed results are rendered by code; RAG supports textual knowledge only; the system uses tool calls plus code-controlled slot filling; channels adapt to a canonical contract; BullMQ processing is ordered/idempotent; core is separated from domain, CRM, and locale packs; lead scoring is explainable; handover is explicit and governed by a state machine; language and script are independent; locale stability is evidence-gated; the operator UI is staged; the web stack is Next.js with REST/SSE; D21 requires the pnpm workspace; D22 requires UI i18n. Addendum overrides D5's naive number-regex requirement with typed provenance and validation of rendered fact references.
- **Universality (v3 §5):** generic core orchestrates shared conversation behavior; versioned domain packs describe catalog, slots, bindings, scoring, prompts, and evals; connectors map external systems to canonical entities and declare capabilities; locale packs own prompts, templates, formatting, and language-specific rules. A new vertical fitting existing capabilities should need no stable-core changes. Addendum requires safe, typed connector contracts and an explicit extension point if a domain needs a genuinely new primitive.
- **Multilingual design (v3 §6):** detect and persist language and script separately, reply in the customer's language and script, normalize Uzbek Latin/Cyrillic and apostrophe variants for matching, keep locale behavior in packs, and mark a locale stable only after native-speaker review and eval thresholds. Launch languages remain open. Addendum adds conservative handling for uncertain language, formal Uzbek “siz”, truthful AI disclosure, and deterministic identity checks after fuzzy matching.

## Repository audit

Evidence reviewed in the checkout: workspace manifests and lockfile; API source/config/tests; shared/config packages; Docker Compose and Dockerfile; CI; `.env.example`; README; ADR 001; and existing progress notes. Confirmed current branch `main`, latest commits `7856f50` and `78bccc7`; worktree was clean before this documentation update.

| Status / phase | Requirement and source | Evidence and gap | Priority | Recommended correction and acceptance |
|---|---|---|---|---|
| **IMPLEMENTED — Phase 0** | Workspace baseline, D21 and v3 §15 Phase 0 | `pnpm-workspace.yaml`, root filtered scripts, `apps/api`, placeholder `apps/web`, `packages/shared`, `packages/config`, Docker Compose, CI, validated env, structured logger, `/health`, ADR 001. API is configured for port 4000. The workspace wiring test imports `@agentcore/shared`. | — | Keep this baseline. Phase 0 acceptance evidence is retained in the earlier commits and the current quality commands are recorded below. |
| **IMPLEMENTED — Phase 1 / shared contracts** | Shared runtime schemas, v3 D21/§13; addendum §4.5 | Shared Zod schemas now validate tenant configuration/locales, connector configuration, retention settings, catalog attributes, slots, quote snapshots/breakdowns, handover summaries, and ISO currency codes. API persistence boundaries consume them. | — | Keep shared schemas as the single contract source; add API/web boundary contracts with their consuming features. |
| **IMPLEMENTED — Phase 1** | Domain and persistence, v3 §9/§15; addendum tenant, privacy and idempotency corrections | Prisma schema, reviewed migrations, composite tenant FKs, provenance fields, exact decimal prices, seed fixtures for two generic tenants, catalog repository, marked isolated PostgreSQL test helper and database-backed constraint tests are present. See [DATA_MODEL.md](DATA_MODEL.md) and [ADR 003](adr/003-phase1-domain-model.md). | — | Complete the validation record below; Phase 2 remains gated on approval and its own implementation plan. |
| **IMPLEMENTED — Phase 2** | Telegram text channel and queue, v3 §10/§15; addendum §4.1/§3.7 | Implemented and integration-tested on 2026-10-22. The `TelegramSender` DI defect that prevented the app from starting was fixed on 2026-10-23 and is covered by a startup smoke test (see Phase 3 completion). | — | — |
| **IMPLEMENTED — Phases 3–4; MISSING — Phase 5** | Connector, generic engine, leads/handover, v3 §§5, 7–8, 15 | Phase 3 connector framework (see Phase 3 completion). Phase 4 agent core, provider adapter, cost controls, education pack and locale packs (see Phase 4 status). No lead capture, handover state machine or operator notifier exists. The agent is not yet wired into the Telegram processor. | P0 before customer-facing automation | Wire the agent into channel processing, then Phase 5. |
| **MISSING — Phase 6 / 6A / 7 onward** | Knowledge, media, inbox, evaluation and analytics, v3 §§6, 12, 12A, 15 | No RAG, media processing, UI framework/screens/i18n, auth/RBAC, eval harness, metrics dashboards, or production operations artifacts exist. `apps/web` is explicitly only a placeholder. | P1, phase-dependent | Add these only at their roadmap gates. Treat voice/image as later work than Phase 2; require tenant isolation, privacy/deletion, provenance/freshness, and eval coverage before customer-facing use. |
| **ADDRESSED — guardrail design** | v3 D5/§7.3 vs addendum §§2, 4.1 | Implemented the addendum approach: provenance-bearing facts from tool results, `{{F<n>}}` references rendered by code, a draft guardrail as a backstop, and code-rendered fallbacks ([ADR 008](adr/008-llm-provider-and-cost-controls.md)). | — | Keep the eval gate (`eval/cases`) on prompt, pack, locale, tool and model changes. |
| **CONFLICT — specification wording** | v3 §§2, 9 “every table has tenantId” vs addendum §3.6 | These v3 statements are broader than the safe ownership model. No database schema exists yet. | P0 before persistence | Require `tenantId` on tenant-owned rows, not the Tenant row or explicitly justified global immutable records. Use tenant-scoped access and composite uniqueness/FKs; verify in schema and negative isolation tests. |
| **CONFLICT — specification wording** | v3 §10 and Phase 2 include Telegram voice/photo; v3 Phase 6 defers speech/image; addendum §4.1 | Conflicting roadmap placement; no media code exists. | P0 before Phase 2 | Apply the addendum override: Phase 2 is text-only. Move voice/image understanding, downloads, and associated privacy/evals to a later phase. |
| **CONFLICT — specification wording (connector side addressed)** | v3 §5.2 and §7.2 loose connector/tool types vs addendum §§3.3, 3.5, 4.4–4.5 | Connector side addressed in Phase 3: Zod canonical contracts, validated inputs and outputs, method presence matching configured operations, registry capability checks ([ADR 006](adr/006-connector-outbound-security-and-contract.md)). Tool argument/result schemas remain Phase 4. | P0 before connector/tool execution | Define concrete shared schemas and typed outcomes; validate capability-method consistency; server code authorizes every call and side effect. Conformance tests must cover each connector. |
| **ADDRESSED — integration boundary** | GenericRestConnector, v3 §5.2 vs addendum §3.5 | Implemented with HTTPS-only STRICT policy, DNS pinning on the real connection, per-hop redirect re-validation, credential stripping across origins, encoded and confined paths, size, time and retry limits, namespaced secret references, and safe mappings ([ADR 006](adr/006-connector-outbound-security-and-contract.md)). Hostname allowlists are not implemented; the per-destination checks apply instead. | P0 before GenericRestConnector | Require HTTPS outside local development, hostname allowlists and post-DNS private-address checks, redirect revalidation, constrained paths/methods, time/size/rate limits, secret references, and safe mapping. Test forbidden destinations and redirects. |
| **RISK — reliability/privacy requirements** | v3 §§10–11 vs addendum §§3.7–3.8 | No inbound/outbound event persistence, outbox, retry state, retention, opt-out, deletion, or PII-redaction behavior exists. | P0 before channel/customer data | Design inbox/outbox (or equivalent), provider-scoped IDs, outbound delivery state, replay/dead-letter handling, documented retention and deletion, consent/opt-out, and redaction before enabling a real channel. |
| **NOT A CONFLICT — Phase 0 layout** | v3 §13 vs current repository | The repository now matches the required monorepo layout. No core/domain/CRM code or user-facing UI exists, so there is no current vertical-specific core leakage or hardcoded UI-string defect to report. | — | Preserve the absence of domain logic in generic core; enforce architecture checks as those modules are introduced. |

## Current phase and acceptance criteria

**Phase 0 — Foundation: complete.** Acceptance evidence is retained from the Phase 0 implementation turn.

**Phase 4B — Agent connected to Telegram (claim → compute → commit), agent mode OFF/SHADOW/LIVE, turn records, failure policy, pricing config, live-eval runner: implemented and verified with deterministic and PostgreSQL tests (2026-10-24); LIVE blocked outside development until Phase 5; live model quality still unverified (no API key).** **Phase 4 — Agent core, packs, locales: implemented and verified with deterministic tests (2026-10-23).** **Phase 2 — Telegram channel and queue: complete.** **Phase 3 — Connector framework: complete as of 2026-10-23** (acceptance evidence under "Phase 3 completion"); a real CRM connector remains blocked on Q1.

**Phase 1 — Domain & persistence: implemented; verification recorded below.** The schema and docs deliberately preserve all open project decisions. No Telegram webhook, queue worker, AI engine, real connector, RAG, media handling, or UI work was added.

No Section 4 question blocks Phase 2's generic text-channel foundation. Q1 blocks a real CRM connector in Phase 3; Q2 and Q4 block provider and launch-locale choices in Phase 4; Q3 affects later operator/pilot sizing; Q5 blocks customer-facing quote policy; Q6 blocks regulated knowledge answers; Q7 blocks Meta setup; Q8 blocks speech work; Q9 blocks production hosting/retention commitments; Q10 blocks account-specific actions. No answer is inferred.

## Open questions and blockers

No Section 4 open question blocks Phase 1: its schema and two-vertical seed can use generic canonical entities and fake data without choosing a real integration, launch locale, model vendor, or currency policy. Do not encode those undecided choices as defaults.

| Open question | Phase(s) affected | Blocking effect |
|---|---|---|
| Q1 — first live project and CRM/API details | Phase 3 real connector; Phase 7 universality proof | Does not block Phase 1–2; use `MockConnector` if live API access is unavailable. |
| Q2 — LLM vendor/models and budget | Phase 4 | **Vendor/model decided by delegated engineering choice** (Anthropic, `claude-haiku-5-5`; [ADR 008](adr/008-llm-provider-and-cost-controls.md)). The monetary budget is **still open**: defaults are provisional. A live API key and the opt-in live evaluation are pending. |
| Q3 — pilot operator count / whether operators also use CRM | Phase 5 integration details and pilot; Phase 6A before pilot if >~3 operators | Does not block Phase 1–4. Operator group baseline is locked by D19. |
| Q4 — v1 customer languages | Phase 4 | Do not claim stable launch locale before confirmation and locale eval. |
| Q5 — currency and price semantics | Phase 4 customer-visible quote/pricing behavior | Must be resolved before rendering actual prices; schema can carry exact amount/currency/basis without choosing values. |
| Q6 — authoritative regulated-info sources and owner | Phase 6 knowledge answers for regulated topics | No regulated policy answer until verified sources and freshness owner are specified. |
| Q7 — Meta onboarding | Phase 8 | Blocks account-based Meta integration only. |
| Q8 — speech-to-text provider and quality | Later media/speech phase (v3 Phase 6; after Phase 2 text-only override) | Blocks speech provider choice and Uzbek quality claims, not text-only work. |
| Q9 — hosting/domain/data residency/retention | Phase 9 production deployment; retention decisions affect earlier personal-data collection | No production data-retention/deployment claim until decided; use safe development-only configuration meanwhile. |
| Q10 — identity verification | Beyond-v1 account-specific data | Account-specific records remain out of scope and must hand over with `AUTH_REQUIRED`. |

Other confirmations from v3 outside §4 remain open: D22 UI locale set, MFA, current Meta messaging-window behavior, and default tenant timezone. They affect the corresponding UI/channel/pilot phases only. No answer is inferred here.

## Verification record
- `pnpm install --frozen-lockfile` (with a local `--store-dir`) — pass; lockfile up to date.
- `pnpm lint` — pass.
- `pnpm typecheck` — pass.
- `pnpm test:unit` — pass: 8 files, 28 tests.
- `pnpm test:coverage` — pass; all unit tests pass.
- `pnpm test:integration` — pass: 2 files, 16 tests against isolated PostgreSQL 18 `agentcore_test` (after `db:generate`). Covers Phase 2 Telegram webhook/idempotency/rate-limit, durable outbox + BullMQ dispatch, per-conversation ordering + debounce, ambiguous send outcomes, and end-to-end echo.
- `pnpm db:test:prepare` — pass: 4 migrations applied to the marked isolated database; subsequent run had no pending migrations.
- `pnpm db:test:seed` twice — pass; two demo tenants seeded idempotently on each run.
- `pnpm db:test:drift` — pass: `No difference detected.`
- `pnpm format:check` — pass. (One pre-existing untracked test file, `apps/api/src/channels/telegram/telegram.integration.spec.ts`, was prettier-formatted; no logic changed.)
- `pnpm build` — pass.
- The CI-equivalent command sequence in `.github/workflows/ci.yml` passed locally; frozen install was run immediately before it.
- Docker is available in this environment (Postgres.app on IPv4 localhost:5432 and homebrew Redis on IPv4 localhost:6379 were used for integration tests; Docker Compose containers `ai-agent-postgres-1`/`ai-agent-redis-1` were also observed running). Remote GitHub Actions were not run.

## Phase 2 status: Telegram intake and durable delivery — complete

Phase 2 (Telegram webhook intake, durable outbox → BullMQ, per-conversation ordering, idempotency, debounce, ambiguous-send handling) is complete and verified:

- Webhook authenticates `X-Telegram-Bot-Api-Secret-Token` before any write; rejects malformed text updates and acknowledges valid unsupported update kinds without storing.
- In one PostgreSQL transaction per webhook: provider-update idempotency key, normalized inbound message, and idempotent outbox event; 2xx returned only after commit.
- Outbox dispatched into BullMQ (outbox ID as job id); debounce via 2s delay; per-conversation processing serialized with `pg_advisory_xact_lock`; out-of-order late messages retained as `FAILED` for visibility rather than replied to out of order.
- Sender sends with 10s timeout; bounded BullMQ retries (≤5 attempts, exponential backoff); Telegram 429/`retry_after` handled as retryable; permanent errors → `FAILED`; ambiguous/timeouts → `UNKNOWN`, never blindly replayed. Exactly-once delivery is NOT claimed (see ADR 005).
- Connector/Crm capability gating and core/pack/separation verified: no domain-specific words in `apps/api/src/core` (no `core` directory exists yet — Phase 2 is Telegram/persistence only).

No commits made; no Phase 3 work started.

## Decisions still open

See the Q1–Q10 table above. The addendum's precedence and its safety corrections are recorded in [ADR 002](adr/002-specification-reconciliation.md); that ADR does not decide any project, vendor, locale, price, operator, hosting, retention, or identity-verification question.

## PostgreSQL connection refactor

The Phase 1 implementation originally used Prisma 6.19 with `url = env("DATABASE_URL")`. This was replaced with Prisma 7.10.0 and `@prisma/adapter-pg`. The schema has no inline URL; Prisma CLI reads the validated `POSTGRES_*` configuration through `prisma.config.ts`, and Nest runtime constructs one bounded adapter pool from the same individual settings. Tests use separate `TEST_POSTGRES_*` settings and the marked `agentcore_test` database. See [ADR 004](adr/004-prisma7-explicit-postgres-configuration.md).

This refactor preserves all models and migration history. It changes the API module format to ESM as required by Prisma 7, generates client code into an ignored source directory, and pins CI and the Docker image to Node 24. Verification passed on Node 24.22.1: frozen-lockfile install; Prisma 7.10.0 schema validation/generation; migration status (`Database schema is up to date!`); `db:test:prepare` (no pending migrations); seed twice; drift (`No difference detected.`); integration (1 file, 10 tests); unit (4 files, 15 tests); coverage (100% statements, branches, functions, and lines for the PostgreSQL settings module); lint; typecheck; format check; and build. The Nest API connected through the adapter and `GET /health` returned `{"status":"ok"}`. The required-variable CLI check produced a clear `POSTGRES_*` field list without printing credentials. `docker compose config --quiet` passed; Compose startup and image build could not be run because the Docker daemon is unavailable.

## Phase 3 status — 2026-10-23, session 2 (takeover from Cline)

Historical record of the second session. Its blockers and remaining work are resolved in "Phase 3 completion" below.

### Stopping point found

- Cline's HTTP-client refactor was half applied: `http-client.ts` called a `prepareHop()` method that did not exist, so `pnpm typecheck` failed (one error), `pnpm lint` reported 5 connector errors, and 10 connector files failed `format:check`. Unit tests passed (8 files, 28 tests) but none covered connectors.
- The planned `dns-pinning.ts` edit was never applied. The existing loop closed each dispatcher in a `finally` *before* reading the body. undici's `close()` waits for in-flight requests and a request stays in flight until its body ends, so any response larger than the socket buffers stalled until the abort timer and surfaced as `CONNECTOR_INVALID_JSON`. A scratch reproduction against undici 7.30.1 confirmed `close()` still pending 1.5 s after a 4 MB response was left unread.
- Other inherited defects: global `fetch` (Node 26's bundled undici 8.9) was mixed with an npm undici 7.30.1 `Agent`; redirect bodies were never consumed; credentials were forwarded to cross-origin redirects; tenant config could set `outboundUrlPolicy: permissive` (all address checks off); `EnvSecretResolver` resolved any environment variable, including platform secrets; path placeholders were not encoded (`../` reached other CRM endpoints); `none`/`cursor` pagination fetched the same page up to `maxPages` times; offers dropped every mapped field and could be linked to the wrong item; canonical offer ids were stripped to `offer:<id>`; writes were retried on timeouts; `search` was advertised when only `getItem` was configured; caller attributes could override the offer id in live checks; the circuit breaker counted 404s as outages and never reset on success.

### What changed

- **HTTP client** ([http-client.ts](../apps/api/src/connectors/generic-rest/http-client.ts)): `Agent.request()` from the installed undici; one pinned dispatcher per hop, owned and released by `send()` after the body is consumed (graceful) or on failure (destroy); one deadline across DNS, hops and body; caller cancellation; size cap; structured error model with `Retry-After`; messages without query strings, credentials or upstream text.
- **DNS pinning and SSRF** ([dns-pinning.ts](../apps/api/src/connectors/generic-rest/dns-pinning.ts), [ssrf-protection.ts](../apps/api/src/connectors/generic-rest/ssrf-protection.ts)): resolve, normalise, validate and pin in one step with no unpinned fallback; family-aware pinned lookup; wider IPv6 coverage; STRICT requires https; code-only loopback exemptions refused in production; resolve-then-discard helpers removed.
- **Connector contract**: per-entity closed-key mappings and typed readers ([field-mapping.ts](../apps/api/src/connectors/generic-rest/field-mapping.ts)); hardened config schema ([rest-config.ts](../apps/api/src/connectors/generic-rest/rest-config.ts)); rewritten [generic-rest-connector.ts](../apps/api/src/connectors/generic-rest/generic-rest-connector.ts); mock input validation and attribute filters; registry instance and registration capability checks and config-fingerprint replacement; [registrations](../apps/api/src/connectors/registry/registrations.ts); namespaced [EnvSecretResolver](../apps/api/src/connectors/registry/secret-resolver.ts); circuit breaker and retry fixes; [ConnectorsModule](../apps/api/src/connectors/connectors.module.ts) wired into `AppModule`; `CONNECTOR_OUTBOUND_POLICY` (strict required in production).
- **Sync core** ([catalog-sync.ts](../apps/api/src/connectors/sync/catalog-sync.ts)): all-or-nothing snapshot fetch, content-hash change planning, deactivate-not-delete, mass-deactivation guard, offers reconciled only when listed.
- **Tests**: shared [conformance suite](../apps/api/src/connectors/testing/conformance.ts) run against two mock catalogs and two generic REST configurations backed by a fictional loopback CRM; connection-path tests with real sockets for lifecycle, timeouts, cancellation, size limits, cleanup-error isolation, pinning, redirect policy, and TLS hostname verification (certificates generated with openssl at test time; nothing committed); config, mapping, pagination, retry, breaker, credential, registry, secret-resolver, mock and sync tests. Test helpers live under `src/**/testing/` and are excluded from the build.
- **Docs**: [ADR 006](adr/006-connector-outbound-security-and-contract.md); Phase 3 note in [OPEN_SOURCE_EVALUATION.md](OPEN_SOURCE_EVALUATION.md); `.env.example` documents the policy and the secret namespace.

### Verification record (Node v26.7.0, pnpm 10.33.3)

- `pnpm typecheck` — pass.
- `pnpm lint` — pass.
- `pnpm test:unit` — pass, stable across repeated runs: 18 files, 340 passed and 7 skipped (347 total; baseline was 8 files and 28 tests). The skips are conformance cases a read-only connector configuration does not support.
- `pnpm test:coverage` — pass. Statement coverage: all files 89.8%, generic-rest 92.9%, dns-pinning 100%, http-client 95.7%, sync core 96.3%.
- `pnpm format:check` — pass. `pnpm build` — pass; `dist` contains no test helpers or specs. `git diff --check` — clean, and no untracked file has trailing whitespace.
- `ConnectorsModule` DI was verified by booting an application context with only `ConfigModule` and `ConnectorsModule` from `dist`: generic-rest is registered in development and production, mock only in development.
- **Blocked:** `pnpm test:integration` stops at `scripts/test-database.ts prepare` because nothing listens on PostgreSQL port 5432 (connection refused on IPv4 and IPv6); the Docker daemon is not running. Phase 1–2 database-backed tests, migration status, seed and drift checks were therefore **not** re-run this session. Redis was reachable. No database was started, reset or modified.
- **Found, not fixed (outside Phase 3):** booting `dist/main.js` fails before any connection with `Nest can't resolve dependencies of the TelegramSender (ConfigService, ?)`. The `request: TelegramFetch = fetch` constructor parameter is emitted as a `Function` DI token and nothing provides one. Unit and integration specs construct `TelegramSender` directly, so no test exercises this path. Suggested fix: inject the transport through an explicit token with `@Optional()`, or remove it from the DI constructor. Then re-run the integration suite and a boot check.
- Environment note: `engines` and CI specify Node 20/22/24 but `.nvmrc` says 26, and only Node 26 is installed here (pnpm prints an engine warning). Verification results on Node 24 were not re-checked.

### Remaining Phase 3 work

1. **Sync persistence and scheduling** (blocked on a reachable PostgreSQL for verification). This needs an additive migration for a tenant-scoped `connector_sync_runs` table with status, counts and error code, plus a partial unique index allowing one running sync per tenant connector. It also needs a Prisma store that applies a `CatalogSyncPlan` in one transaction: tenant-scoped upserts on `(tenant_id, source_system, source_entity_id)`, `normalized_title`, `{fields}` attributes, decimal price, and deactivation through status/`deleted_at`. Then a BullMQ queue and worker with a deterministic job id per tenant connector, stale-run recovery, and integration tests. No migration was added this session because none could be verified.
2. Reconcile the shared `TenantConnectorConfigSchema` (strict: `fieldMappings` and `pageSize` only) with connector-specific configuration before generic REST config is stored in `tenant_connectors.config`. Today it is referenced only by a Phase 1 test.
3. First real connector: blocked on Open Question 1 (recommended EduFlow/Learnix).
4. Outbound write-body field mapping for CRMs that do not accept the canonical lead/booking shape.

### Known limitations and unresolved security concerns

- Pinned dispatchers are not pooled, so every request performs a fresh TCP/TLS handshake.
- Environment-based connector secrets are deployment-wide, not tenant-scoped.
- Hostname allowlists per tenant are not implemented; protection relies on per-destination address checks.
- TLS tests require `openssl` and are skipped (not failed) without it. The tests cover hostname mismatch, untrusted CA, and `NODE_TLS_REJECT_UNAUTHORIZED=0`. They do not cover revocation, expiry, or a public CA chain.
- DNS-rebinding protection is proven on the connection path with an injected resolver and loopback servers. It has not been exercised against a live adversarial DNS server.
- The generic REST connector does not implement inbound webhooks (`webhooks: false`).

No commits were made and nothing was staged. Phase 4 was not started.

## Phase 3 completion — 2026-10-23, session 3

### Environment found

- The working tree contained the uncommitted work of the previous sessions (43 entries), and there was no git remote. PostgreSQL was not running; Postgres.app 18 was installed, so its existing data directory was started with `pg_ctl start` (no init, reset or drop). Redis was reachable. The Docker daemon was not running and `gh` was not installed. Only Node v26.7.0 is installed, while `engines` and CI use Node 24.
- Baseline before changes: `pnpm test:integration` passed (2 files, 16 tests) and no migrations were pending.

### What changed

- **Startup fix:** `TelegramSender` receives its transport through an optional `TELEGRAM_FETCH` injection token and defaults to global `fetch`. Regression tests resolve it through the Nest container with and without the token. [app.startup.integration.spec.ts](../apps/api/src/app.startup.integration.spec.ts) boots the full `AppModule` against the test database and Redis and calls `/health`. As a negative control, restoring the old constructor makes the smoke test fail with `Nest can't resolve dependencies of the TelegramSender (ConfigService, ?)`. The compiled `dist/main.js` was also started as a process and `/health` returned `{"status":"ok"}`.
- **Config contract:** the tenant connector schemas live in [connector-config.ts](../packages/shared/src/connector-config.ts), with `TenantConnectorConfigSchemas` and `parseTenantConnectorConfig`. The conflicting flat `TenantConnectorConfigSchema` was removed. [TenantConnectorLoader](../apps/api/src/connectors/sync/tenant-connector-loader.ts) validates rows against this contract, refuses the unvalidated `secret_ref` column, and checks stored capabilities against advertised ones.
- **Sync persistence:** migration `20261023110000_phase3_catalog_sync_runs` (additive), with the [store](../apps/api/src/connectors/sync/catalog-sync.store.ts), [service](../apps/api/src/connectors/sync/catalog-sync.service.ts) and [BullMQ runtime](../apps/api/src/connectors/sync/catalog-sync.queue.ts) wired into `ConnectorsModule`. New environment settings: `CATALOG_SYNC_INTERVAL_MINUTES`, `CATALOG_SYNC_STALE_AFTER_SECONDS`, `CATALOG_SYNC_MAX_ITEMS`. The Redis connection helper moved unchanged to `src/queue/redis-options.ts`.
- **Defect fixed in the sync core:** the snapshot took its source system from the first record, so an empty upstream listing reconciled against the wrong scope and the mass-deactivation guard could not fire. A syncing connector must now declare `sourceSystem`.
- **Outbound write mapping:** `requestBody` on `createLead`, `updateLead` and `createBooking` (see [ADR 007](adr/007-catalog-sync-persistence-and-connector-config-contract.md)).

### Phase 3 acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | Canonical interface and capability model | Registry, capability and conformance tests pass. |
| 2 | `MockConnector` passes the conformance suite | 2 fictional catalogs pass. |
| 3 | `GenericRestConnector` validates config and responses | Config, mapping, pagination, identity and error-model tests pass. |
| 4 | HTTP client and DNS pinning tests green | Pass (real sockets, TLS, redirects). |
| 5 | Config schema matches the implementation | One shared contract; loader and connector use it; rejection tests pass. |
| 6 | Sync persisted, transactional, idempotent | Integration tests: import, idempotent re-run, deactivate and reactivate, atomic rejection of a bad record, price-precision guard, tenant isolation. |
| 7 | BullMQ processing and stale-run recovery | Integration: real Redis job to `SUCCEEDED`; stale run recovered at claim and by the scheduler sweep; lost run refuses to apply; DB rejects a second running run. |
| 8 | Outbound write mappings validated | Unit tests against a controlled local CRM, plus config rejection tests. |
| 9 | The NestJS application starts | Smoke test and `dist/main.js` boot. |
| 10 | Phase 0–2 intact | Baseline 16 integration tests still pass; seed ran twice; drift clean. |
| 11 | Documentation reflects verified results | This section, ADR 006 and ADR 007. |
| 12 | Real CRM explicitly blocked | Open Question 1 unanswered; no CRM-specific connector or invented endpoints. |

### Verification record (Node v26.7.0, pnpm 10.33.3, PostgreSQL 18 via Postgres.app, local Redis)

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm build` — pass.
- `pnpm test:unit` — pass: 18 files, 360 passed, 7 skipped (the conformance cases a read-only configuration does not support).
- `pnpm test:integration` — pass on two consecutive runs: 4 files, 37 tests (16 existing Phase 1–2, 1 startup smoke, 20 catalog sync).
- `pnpm db:test:prepare` applied the new migration; `pnpm db:test:seed` twice — pass; `pnpm db:test:drift` — `No difference detected.`; `pnpm db:generate` — pass.
- `pnpm test:coverage` (unit suite only) — pass: all files 80.9% statements. The sync store, service and queue are covered by the integration suite, which this script does not instrument.
- **GitHub Actions CI** (private repository `XusanboyNazirboyev/ai-agent`, Node v24.21.0, PostgreSQL 16 and Redis 7 service containers): the first run failed at `pnpm db:test:seed` with `ERR_MODULE_NOT_FOUND` for `@agentcore/shared/dist`. `prisma/seed.ts` imports the shared package, and nothing had built it in a fresh checkout; locally a stale `dist` hid this. The root `db:seed` and `db:test:seed` scripts now build shared first. The full CI sequence was replayed locally without the shared build output and passed. The CI run for commit `eaf36a8` then passed every step: unit 360 passed and 7 skipped, integration 37 passed, drift clean.
- Not run: Docker Compose (daemon not running locally).

### Known limitations

- Each sync applies in one transaction (120 s timeout), bounded by `CATALOG_SYNC_MAX_ITEMS`.
- Run history has no retention policy (Q9). The `secret_ref` column is refused rather than dropped.
- The limitations recorded in session 2 still apply: no dispatcher pooling, deployment-wide env secrets, no per-tenant hostname allowlists, and no live adversarial DNS test.
- A real CRM connector is blocked on Q1 (recommended EduFlow/Learnix). Phase 4 has not started.

## Phase 4 status — 2026-10-23: implemented; live verification pending

### State found

- Clean tree on `main`, in sync with `origin/main` at `c6946c4`, with the TelegramSender DI fix intact. PostgreSQL (Postgres.app) and Redis were running.
- No LLM code existed. No provider API key exists in this environment (no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`; `.env` has no provider entry; no CLI profile).

### Decisions

- Provider and model, chosen under delegated authority: Anthropic Claude API with `claude-haiku-5-5` for both tiers. Anthropic and OpenAI tied on the weighted criteria; the tie-breakers and a model-bias disclosure are in [LLM_PROVIDER_EVALUATION.md](LLM_PROVIDER_EVALUATION.md) and [ADR 008](adr/008-llm-provider-and-cost-controls.md).
- Pricing snapshot `anthropic-2026-10-23`, from the official page checked 2026-10-23.
- Provisional limits (configurable, not owner-approved): $0.02 per turn, $0.25 per conversation, 6 calls, 3 tool rounds and 6 tool calls per turn, 1,024 output tokens per call, 48 KB input per call. The tenant monthly cap is optional and unset. Estimated cost on Haiku 5.5: about $0.0048 for a typical conversation and $0.029 for a heavy one.

### Implemented

- **Provider abstraction** (`src/core/llm/llm-provider.ts`) and the **Anthropic adapter** (`src/llm/anthropic/`). The adapter uses structured output via JSON Schema, strict tools with `tool_choice: auto`, opaque thinking-block replay, explicit refusal/truncation/malformed outcomes, its own bounded retries with `retry-after` and an accurate attempt count, and SDK retries disabled.
- **Deterministic `ScriptedLlmProvider`**, which is also the default `LLM_PROVIDER=mock`.
- **Cost controls:** integer nano-USD pricing (`pricing.ts`), worst-case reservation before every call (`budget.ts`), and settlement against reported usage via `MeteredLlm`. Usage goes to `llm_usage_records` through the additive migration `20261023150000_phase4_llm_usage_records`, which is idempotent on the provider response id.
- **Agent core** (`src/core/agent/`):
  - deterministic language/script detection with locale stickiness;
  - a pack-driven slot engine with script-insensitive enum normalization;
  - a tool registry and executor: pack and capability gating, argument validation, ids restricted to this turn's results, deduplication, timeouts, output re-validation;
  - a fact store with provenance;
  - the draft guardrail;
  - versioned prompts with sanitized, delimited customer data;
  - the turn orchestrator, with one question at a time, early search, one relaxed search, a bounded tool loop, one regeneration and code-rendered fallbacks.
- **Core isolation** is enforced by `src/core/architecture.spec.ts`. It found and fixed domain words in the language detector's vocabulary.
- **Shared contracts:** the Domain Pack schema, and Uzbek Latin↔Cyrillic transliteration plus `normalizeForMatching`. A `yo'` → `йў` transliteration bug was found while reviewing the Cyrillic templates and fixed with a regression test.
- **Packs and locales:** `education@1`, and `uz-Latn`, `uz-Cyrl`, `ru`, `en`, all `beta` with `nativeReviewed: false`.
- **`AgentConversationService` / `AgentModule`:** tenant-scoped context loading (pack, locales, latest slot version, history, active connector, prior spend), turn execution, and persistence of slots and locale.
- **Environment validation:** `LLM_PROVIDER=anthropic` without a key fails at startup, and unpriced models are rejected.
- **Evaluation:** 76 cases (19 categories × 4 locales) in `eval/cases/education`, run in CI with scripted model outputs. `pnpm --filter @agentcore/api eval:live` is opt-in (`LIVE_EVAL=1`, key required, budget-capped).

### Verification record (Node v26.7.0 locally)

- `pnpm lint`, `typecheck`, `format:check` and `build` — pass. `git diff --check` — clean.
- `pnpm test:unit` — 547 passed, 7 skipped. Coverage: all files 84.1% statements, core/agent 91.6%, core/llm 90.5%, Anthropic adapter 87.1%.
- `pnpm test:integration` — 41 passed: Phase 1–3 suites, the startup smoke test, and 4 agent tests covering a two-turn dialog with slot/locale/usage persistence, idempotent usage recording, the conversation budget enforced from the stored ledger, and ledger CHECK constraints.
- Migrations applied to `agentcore_test`. Seed ran twice. Drift: `No difference detected.`
- `dist/main.js` booted against the test database with `AgentModule`, and `/health` returned `{"status":"ok"}`.
- **Not verified:** any live Claude API request (no key); real latency, rate limits and token counts; model quality in Uzbek, Russian and English; tool-selection accuracy. The adapter is unit-tested on request/response shapes only.

### Known limitations and open items

- ~~The agent is not connected to Telegram yet.~~ Done in Phase 4B (ADR 009).
- The input-size reservation is a byte-based estimate; any underestimate is recorded as overshoot.
- Monetary budgets are provisional and need owner approval (Q2). The tenant monthly cap has no default. Anthropic's retention terms are inconsistent between its pages (Q9).
- Locale wording has not been reviewed by native speakers. No locale may become `stable` before review and a live eval threshold (D18).
- No lead capture, handover state machine or operator notification (Phase 5). No RAG or voice. A real CRM is still blocked on Q1.

## Phase 4B status — 2026-10-24: agent integrated with Telegram (shadow-first)

### State found
- The repository was on `main` at `c6edb74`, with a clean tree.
- The Phase 2 processor built the echo reply inside one transaction holding the conversation advisory lock.
- The Phase 4 agent (`AgentConversationService.handleCustomerMessage`) persisted slots itself and was not wired to any channel.

### What changed
- **Pipeline.** `TelegramAgentPipeline` runs claim → compute → commit, with no transaction or connection held while the model runs. Agent turns are idempotent on `agent-reply:<conversation>:<answered sequence>`. A newer message supersedes and re-runs the reply, an operator takeover discards it, a crashed attempt is abandoned on retry, and an expired lease can be taken over. A busy conversation is re-checked later through a BullMQ delay that consumes no retry attempt. The Phase 2 batch selection moved unchanged into `inbound-batch.ts`.
- **Agent mode.** `ChannelAccount.agentMode` takes OFF (default; Phase 2 echo), SHADOW (draft only) or LIVE. LIVE requires an operator notifier, so it is refused outside development: the startup check, the `agent:mode` script and processing (which degrades it to SHADOW) all enforce this.
- **Records.** New table `agent_turns`: tokens, estimated and actual cost, latency, models, redacted tool calls with typed outcomes, guardrail results, facts with provenance, draft, correlationId. `handovers` gains `idempotency_key` and `notification_status` (always PENDING until Phase 5).
- **Migrations.** `20261024090000_phase4b_agent_turns` and `20261024091000_phase4b_agent_turn_seen_sequence`, both additive, with partial unique indexes and CHECK constraints.
- **Failure policy.** Distinct reasons: LLM_UNAVAILABLE (including the whole-turn deadline `AGENT_TURN_TIMEOUT_MS`), BUDGET_EXCEEDED, TOOL_LOOP_LIMIT, CONNECTOR_UNAVAILABLE, NO_DATA and GUARDRAIL (a refusal or two rejected drafts). Handover templates in all four locales now only say the message was recorded.
- **Pricing.** Versioned decimal config with `asOf`, source URL and long-prompt tier, converted exactly to nano-USD. Prompts over the tier threshold are refused, `LLM_MAX_INPUT_BYTES` is validated against it, and a startup warning fires after 30 days.
- **P0 fixes.** CRM text is escaped in prompts. New AI-disclosure intent. Mixed-script messages no longer flip the conversation script. The transliterator now gives the hard sign after consonants (`san'at` → `санъат`).
- **Eval.** 50 cases each for uz-Latn and uz-Cyrl (19 each for ru and en), generated by `eval/generate_education_cases.py`.
- **Live-eval runner.** Model comparison, a run budget checked before every call, a per-model report naming provider and model, and the key read from `.env.local` only.
- **Docs.** [ADR 009](adr/009-agent-turn-pipeline-and-agent-mode.md) and [PHASE4_COMPLIANCE.md](PHASE4_COMPLIANCE.md).

### Verification record (Node v26.7.0 locally; CI uses Node 24)

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `db:generate`, `db:test:prepare` | pass |
| `db:test:seed`, run twice | pass |
| `db:test:drift` | No difference detected |
| Migration from an empty database (`agentcore_scratch_phase4b`, created for this check) | all 8 migrations applied, drift: No difference detected |
| lint, typecheck, format:check, build | pass |
| test:unit | 641 passed, 7 skipped |
| test:integration (files now serial: shared database and Redis queue) | 61 passed, two consecutive runs |
| test:coverage (unit only) | all files 78.9%, core/agent 93.1%, core/llm 91.7% |
| Local end-to-end run (real AppModule, PostgreSQL, Redis/BullMQ, mock model, recording fake Telegram transport) | update → webhook 200 → COMMITTED SHADOW turn with draft; 0 outbound messages, 0 `telegram.send` rows, 0 transport calls |

The pipeline and service code (`agent/`, `channels/telegram/`) is exercised by the integration suite, which unit coverage does not count.

### Known limitations and open items
- **No live model run.** No API key was available, so model quality, tool-call validity and latency on Claude are unmeasured.
- **LIVE blocked.** It is blocked outside development until the Phase 5 operator notifier exists; handovers stay `notification_status = PENDING`.
- **Re-billing on retry.** A crash between compute and commit re-bills the next attempt. This is bounded by the budgets and recorded per attempt.
- **Open compliance items.** Listed prices are not yet forced through a live quote, and `Quote` rows are not written (Phase 5). `LOW_LANG_CONFIDENCE` has no trigger (Phase 7). Regulated knowledge is missing (Phase 6). See [PHASE4_COMPLIANCE.md](PHASE4_COMPLIANCE.md).
- **Mock mode is limited.** The offline mock model extracts nothing, so free-text slots such as `subject` are only asked for, never filled.

## OpenAI-compatible provider — 2026-10-24

**Added.**
- A generic `openai-compatible` LlmProvider (Gemini free tier or local Ollama via env config).
- Typed rate-limit, quota, transient, invalid, unauthorized and unsupported-feature errors, with bounded jittered retries honoring Retry-After.
- A client-side RPM/TPM/RPD limiter.
- Free and wildcard price entries, and token budgets per turn and per conversation.
- A data-protection guard: only `LLM_TRUSTED_PROVIDERS` (default `mock`) may see real customer data. For any other provider, LIVE is refused and SHADOW is allowed only on test accounts or with `LLM_ALLOW_REAL_CUSTOMER_DATA=true`; otherwise the account is held.
- Live eval through the new provider.

**Migrations** (additive): `llm_usage_records.usage_estimated` and `channel_accounts.is_test_account`.

See [ADR 010](adr/010-openai-compatible-provider-and-data-protection.md) and the verified facts in [LLM_PROVIDER_EVALUATION.md](LLM_PROVIDER_EVALUATION.md) §10.

**Not verified.**
- No live call to Gemini or Ollama: no key or local server was available.
- Gemini support for `response_format: json_schema` and `max_tokens` is undocumented; both are configurable.
