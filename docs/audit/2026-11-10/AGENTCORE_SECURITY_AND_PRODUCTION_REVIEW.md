# AgentCore — security and production review (2026-11-10)

Tree `8dd5de0`; staging host checked read-only on 2026-11-10 (setting names and non-secret flags only; no secret value was read or printed). Prior audit `docs/audit/2026-11-05-staff-audit.md` findings were revalidated: **S1** (vulnerable dependencies) fixed — `pnpm.overrides` for body-parser/multer/mysql2, lockfile `body-parser@2.4.0`; **S2** (no HTTP hardening) fixed — `apps/api/src/http/security-headers.ts` (nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, JSON body limit) + HSTS in `deploy/Caddyfile`; **S4** (root container) fixed — `Dockerfile.production` `USER node` + `HEALTHCHECK`, CI asserts non-root; **S5** (shutdown hooks) fixed — `enableShutdownHooks()`; **S3** (webhook-secret rotation) still open; **S6** (isolation by convention) still open.

## Findings (ordered by risk)

| ID | Severity | Finding | Evidence | Remediation |
|---|---|---|---|---|
| SEC-01 | **High once real customer data exists** (owner 2026-11-11: staging holds demo and test data only, so it is not urgent today) | Backups exist only on the same instance and have never been restored in a drill | `deploy/README.md` ("dumps stay on the instance's disk"); `/etc/cron.d/tezda-backup` daily 02:30; manual dump verified readable (`pg_restore --list`, 43 table-data entries) | Off-host copy to S3 (separate role, encryption, lifecycle), monthly restore drill, written RPO/RTO (roadmap P0.1) |
| SEC-02 | **High** | No MFA for platform admins or tenant owners | no TOTP/WebAuthn code in `apps/` | TOTP + recovery codes, enforced for platform roles (P0.2) |
| SEC-03 | **High (privacy)** | Real customer messages may reach free third-party model endpoints: staging trusts `openrouter` and the fallback chain includes `:free` models | `apps/api/src/llm/routing/routing-policy.ts:68-80`; staging `LLM_TRUSTED_PROVIDERS=routed,gemini,groq,mistral,openrouter` | Remove `:free` endpoints from routes that carry real data, or restrict them to SHADOW/test tenants; record each provider's data-use terms (unverified here) — owner decision Q9 |
| SEC-04 | Med-High | Tenant isolation relies on every query passing `tenantId`; no Postgres RLS | 0 migrations with `ROW LEVEL SECURITY`; mitigations: composite `(tenant_id, id)` FKs, isolation integration tests (inbox, SSE), platform import-boundary test | RLS on high-risk tables as defence in depth (P0.7) |
| SEC-05 | Medium | Secrets handled through SSM command text (kept in SSM history) and a plain `.env.production` on the host; one third-party API key was pasted into a chat on 2026-11-10 | session practice; `deploy/bootstrap-staging.sh` generates `.env.production` | Instance role + Parameter Store/Secrets Manager read at boot; rotate exposed keys (P0.3) |
| SEC-06 | Medium | No secret, dependency or container scanning in CI | `.github/workflows/ci.yml` has no gitleaks/audit/Trivy/CodeQL step | Add scanners with a baseline (P0.4) |
| SEC-07 | Medium | No general API rate limiting; only login is limited | login limiter (`webinbox/login-limit.integration.spec.ts`); no Throttler or equivalent | Per-IP and per-session limits at Caddy or Nest before the public web chat |
| SEC-08 | Medium | Retention and deletion not enforced: `tenants.retention_settings` never read; `inbound_events.expires_at` without a purge job; deletion only as a legal page | grep: no readers of `retentionSettings`, no `inboundEvent.deleteMany` | Purge jobs + OWNER-initiated contact erasure with audit (P0.6) |
| SEC-09 | Medium | Single EC2 instance runs everything (pilot topology, ADR 035) | `docker-compose.prod.yml` + local DB file | Accept for pilot; plan RDS + two app instances before paying customers depend on it (P4.5) |
| SEC-10 | Low-Med | Webhook secret rotation not built (prior S3) | no rotation flow besides cipher key rotation in `secrets/secret-cipher.ts` | Rotation endpoint + runbook |
| SEC-11 | Low | Platform admin has no password change/reset; first password was delivered through SSM command output | ADR 047 console | Self-service change + MFA enrolment at first login |
| SEC-12 | Low | Database migrations are not reversible by the deploy rollback (image rollback keeps the previous tag) | `deploy/bootstrap-staging.sh` keeps `previous` tag | Keep migrations additive (current practice) and take a dump before migrating (done manually on 2026-11-10) |

## Controls verified in code (evidence level C T W)
- **Sessions:** opaque tokens hashed at rest in an `HttpOnly` cookie (`webinbox/auth.controller.ts:108`; the CSRF cookie is readable on purpose for double submit), `SameSite=Strict`, `Secure` on staging (`SESSION_COOKIE_SECURE=true`), expiry and revocation; separate platform sessions and cookies (ADR 047).
- **CSRF and Origin:** double-submit token bound to the session hash; Origin allow-list (`webinbox/session.guard.ts`, `platform` guard).
- **Passwords:** scrypt (N=2^16), lockout after failed attempts, timing-safe compares.
- **RBAC:** enforced in the API on every write (spec 12A.3); SUPPORT read-only tested over HTTP; last-owner protections.
- **Webhooks:** Meta `X-Hub-Signature-256` on raw bytes (`channels/meta/meta-webhook-auth.ts`), Telegram secret token header; dedupe by provider id.
- **OAuth:** state checked in Instagram and Facebook connect controllers.
- **SSRF:** STRICT outbound policy + DNS pinning for connectors and customer media (`connectors/generic-rest/ssrf-protection.ts`, `dns-pinning.ts`, `channels/voice/media-download.ts`).
- **Secrets at rest:** AES-256-GCM per tenant (`secrets/secret-cipher.ts`, `channel_secrets`, `connector_secrets`).
- **Web:** nonce-based CSP (ADR 021, `apps/web/src/csp.ts`); the API is reachable from browsers only through the web proxy (same origin, so no CORS surface); `/health` not exposed by Caddy.
- **Audit:** `audit_events` and `platform_audit_events` on sensitive writes.
- **Graceful shutdown:** hooks enabled and queue runtimes close workers — **NOT VERIFIED** under SIGTERM with in-flight jobs.

## Backup, recovery, deployment readiness
| Item | State |
|---|---|
| Backup | daily `pg_dump` 02:30 on host, 7-day retention; extra dump taken 2026-11-10 13:26 UTC before the ADR 047 migration |
| Off-host copy | **none** |
| Restore drill | **never run** |
| RPO / RTO | not defined (practically RPO 24 h, RTO unknown; instance loss = data loss) |
| Deploy | GitHub Actions → OIDC role → SSM → `bootstrap-staging.sh` (pull, migrate, start, keep previous tag); smoke checks `/login` 200, `/api/v1/auth/me` 401 |
| Monitoring | in-app alerts (ADR 030), structured logs with correlation ids; **no external uptime/alerting** found |
| Environments | staging only; no production |

## Testing and verification (Phase 8)
Counts at `8dd5de0` (local run 2026-11-10): API unit 2,284 passed + 1 environment-coupled failure (`src/agent/live-eval-runner.spec.ts` fails when the root `.env` names an unpriced model), web unit 120, integration 583 (real Postgres), e2e 111/112 locally (one intermittent `layout.spec.ts` overflow check; the same family failed 6 times in recent CI history), CI run `42820276164` green.

| Area | State | Gap |
|---|---|---|
| Multi-tenant isolation | integration tests for inbox reads, SSE, platform/tenant session separation | no RLS-level tests; no fuzzing of id-only lookups |
| Webhooks | signature, dedupe, ordering tests | no replay/load test against real Meta payload variety |
| AI evaluation | `pnpm test:eval` in CI (mock), live eval script; 33 known live-eval failures (uz-Cyrl, FALLBACK) | no per-tenant eval set; no regression gate on live quality |
| Multilingual | uz-Latn, uz-Cyrl, ru, en cases | native-speaker review pending (D18) |
| Voice | unit + integration with fakes; WER on 9 owner recordings | small sample; no latency SLO for transcription |
| Load / stress | **none** | needed before pilots (webhook bursts, SSE fan-out, LLM concurrency) |
| Browsers | Chromium only | Safari/Firefox unverified |
| Payments | n/a (Click not built) | Click callback contract tests when built |
| Security tests | unit/integration for auth, CSRF, SSRF | no DAST, no scanners in CI |

**Verification ladder for headline features**

| Feature | Code | Tests | Wired | Provider | Real world | Production |
|---|---|---|---|---|---|---|
| Telegram agent | yes | yes | yes | yes | yes (staging) | no |
| Instagram DM + voice | yes | yes | yes | yes | yes (staging, 2026-11-10) | no |
| Instagram comments | yes | yes | yes | not subscribed | no | no |
| Messenger | yes | yes | yes | no Page | no | no |
| Bitrix24 lead sync | yes | yes | yes | yes | yes (3 leads) | no |
| Platform console + subscriptions | yes | yes | yes | n/a | admin created; first login by owner pending | no |
| Appointment scheduling | yes | yes | tools only | n/a | no (0 appointments) | no |
| Voice calls | partial | yes | no | keys only | no | no |
| Click | no | — | — | — | — | — |

## Remediation log
- **2026-11-11, SEC-06 (P0.4), branch `feat/p0-hardening`:** CI job `security` runs `pnpm audit --prod --audit-level=high` and gitleaks `v8.21.2` (`.gitleaks.toml`: default rules; test doubles, fixtures, lockfile and `.git/` allow-listed); the `images` job scans the three images with Trivy `0.57.1` for fixable CRITICAL CVEs; `publish` (staging deploy) now also needs `security`. Verified locally: `pnpm audit` exits 0 with the exception below; workflow YAML and TOML parse. **Not verified locally:** gitleaks and Trivy (no Docker on the workstation; downloading their binaries was refused by the session's safety policy) — first proof is the CI run.
  - **Accepted advisory `GHSA-ggr8-5vv4-36mx`** (`deepmerge-ts < 8.0.0`, uncontrolled recursion, CVSS 8.2, availability only), reached through `prisma → @prisma/config`. Exploitation needs two self-referencing object graphs at the same path; plain JSON cannot create them and Prisma merges only its own configuration objects, never request data. Fixing means a major bump inside Prisma's dependency tree (not done: no dependency changes in this phase). **Review by 2026-12-31** or when Prisma ships `deepmerge-ts >= 8`.
- **2026-11-11, SEC-02 (P0.2):** TOTP MFA for platform admins (forced) and tenant operators (optional) per ADR 048, migration `20261116090000_mfa_totp`; integration 599/599, e2e 114/114, unit 2303 + the 1 known environment-coupled failure. Not built yet: a server CLI to reset the last platform owner's MFA, a tenant setting that requires MFA, a QR image. Not verified: a real authenticator app. Staging has the secrets keyring (`SECRETS_MASTER_KEY` set), which platform sign-in needs once MFA ships.
- **2026-11-11, P0.5:** answer-quality baseline on staging in `AGENTCORE_QUALITY_BASELINE_2026-11-11.md`; `LLM_MAX_OUTPUT_TOKENS=2048` set on staging on the owner's approval (backup `.env.production.bak-…` on the host); re-measure in 3-5 days.

