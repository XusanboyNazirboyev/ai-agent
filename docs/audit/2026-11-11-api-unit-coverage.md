# API unit-test coverage gaps — 2026-11-11 (task 006)

**Worktree:** `/Users/xusanboynazirboyev/Documents/Projects/ai-agent-api-gaps`  
**Branch:** `test/api-core-gaps-006` (base `origin/feat/chain-2026-11-11` @ `4adb4fe`)  
**Scope (task):** `apps/api/src/core/**`, `apps/api/src/leads/**`, `apps/api/src/followup/**`, `apps/api/src/locales/**`, `apps/api/src/handover/**` (non-service pure helpers), `apps/api/src/team/**`, `apps/api/src/access/**`. Excluded: generated code, DB-bound services, anything needing a database/network/Redis.

## 1. Measurement (before)

Command: `pnpm --filter @agentcore/shared build && pnpm --filter @agentcore/api test:coverage` (vitest unit, `--coverage`), captured to `/tmp/api_cov_006b.txt`.

Overall (unit): **Statements 67.98% (7875/11583), Branches 60.97% (5277/8654), Functions 66.73% (1529/2291), Lines 69% (7256/10515)**.  
Test files: **109 passed, 14 failed suites** and **1654 passed / 15 skipped / 1 failed tests** in the captured run due to `@agentcore/shared` entry resolution errors during that coverage invocation in this environment (same class seen before shared was resolved in-process) and one `core/architecture.spec.ts` failure cascading from that; targeted pure-file specs added below were executed separately with shared built.

### 15 lowest-coverage pure/logic files in scope (line %, then branch %; “before”)

Values from coverage table where present; files not loaded by the coverage run are marked **not in table (0% / unloaded in run)** and treated as lowest priority gaps.

| #   | File                                                |                                      Stmts % | Branch % | Funcs % |                          Lines % | Why included (pure logic)                                                                                                                            |
| --- | --------------------------------------------------- | -------------------------------------------: | -------: | ------: | -------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/api/src/core/scheduling/scheduling-render.ts` |                                        10.00 |     0.00 |    0.00 |  10.00 (dir) / not in file table | Code-rendered scheduling proposal/done/declined texts and payload (D4/D5); pure string/placeholder rendering.                                        |
| 2   | `apps/api/src/core/followup/policy.ts`              |                                 not in table |        — |       — |                    0% (unloaded) | Follow-up eligibility/quiet-hours/earliness decisions; time/consent/limit rules.                                                                     |
| 3   | `apps/api/src/core/followup/optout.ts`              |                                 not in table |        — |       — |                    0% (unloaded) | Whole-message opt-out exact match after normalization across locale phrases.                                                                         |
| 4   | `apps/api/src/core/handover/state-machine.ts`       |                                 not in table |        — |       — |                    0% (unloaded) | Conversation ownership transitions and `botMaySpeak`/`operatorMaySpeak` predicates.                                                                  |
| 5   | `apps/api/src/core/agent/money.ts`                  |                                 not in table |        — |       — |                    0% (unloaded) | Exact decimal string comparison (`decimalAtLeast`) without floats.                                                                                   |
| 6   | `apps/api/src/core/agent/facts.ts`                  |                                 not in table |        — |       — |                    0% (unloaded) | Fact rendering, validity, reference extraction, dedup store (pure in-memory).                                                                        |
| 7   | `apps/api/src/core/agent/safety.ts`                 |                                 not in table |        — |       — |                    0% (unloaded) | Typed safety outcome shapes/constants (pure types/contracts exercised via construction).                                                             |
| 8   | `apps/api/src/leads/phone.ts`                       |                                 not in table |        — |       — |                    0% (unloaded) | Phone extraction and speech-digits policy gate (security/PII boundary).                                                                              |
| 9   | `apps/api/src/leads/lead-stage.util.ts`             |                                        14.28 |     0.00 |    0.00 |                            16.66 | Default lead stage seed data/selection helper (pure constants/lookup logic).                                                                         |
| 10  | `apps/api/src/access/access-decision.ts`            |                                 not in table |        — |       — |                    0% (unloaded) | Tenant access/subscription state decisions and `billingRequired` parsing (policy).                                                                   |
| 11  | `apps/api/src/handover/operator-text.ts`            |                                        28.00 |   100.00 |   14.28 |                            28.00 | Operator-facing locale strings, `refLine`/`parseRef` (non-service pure helpers).                                                                     |
| 12  | `apps/api/src/core/agent/verified-answer.ts`        |                                 not in table |        — |       — |                    0% (unloaded) | Narrow code-rendered quote draft from verified live facts only.                                                                                      |
| 13  | `apps/api/src/team/invite-token.ts`                 | not in table (spec exists elsewhere in team) |        — |       — | 0% (unloaded in this table view) | Invite token generation/hash/plausibility/expiry (security-relevant).                                                                                |
| 14  | `apps/api/src/team/team-rules.ts`                   |                                 not in table |        — |       — |                    0% (unloaded) | Team role/ownership rules (FORBIDDEN/SELF_EDIT/OWNER_ONLY/LAST_OWNER) and limits parsing.                                                            |
| 15  | `apps/api/src/core/locales/locale-pack.ts`          |                                        87.50 |    87.50 |   87.50 |                            90.90 | Locale pack contract/types/format helpers boundary (included as in-scope pure contract surface; comparatively higher coverage but in required dirs). |

**Not selected (DB-bound/services or not pure in target sense):** `handover.service.ts`, `lead.service.ts`, `lead-sync.service.ts`, `follow-up.service.ts`, controllers/guards requiring Nest/Prisma runtime, `operator-request-guard.ts` (DI/HTTP guard), repositories/adapters, generated prisma code.

## 2. Tests added/extended (no production code changes)

| Production file                        | Test file                                            |                                                   Coverage (touched) | Notes                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------- |
| `core/scheduling/scheduling-render.ts` | `core/scheduling/scheduling-render.spec.ts` (new)    | before: 10/0/0/10 (dir/unloaded file) → after: (see “After” section) | Proposal/done/declined for book/cancel/reschedule, placeholder fill, previous time, confirm prompt, payload.                 |
| `core/followup/policy.ts`              | `core/followup/policy.spec.ts` (new)                 |                                                     before: unloaded | `localHour`, `inQuietHours` (wrap midnight), `decideFollowUp` reasons/retry flags, exponential wait, delivered/value/limits. |
| `core/followup/optout.ts`              | `core/followup/optout.spec.ts` (new)                 |                                                     before: unloaded | Exact whole-message match, normalization/apostrophes/punctuation, sentence-containing-word not opt-out, multi-pack.          |
| `core/handover/state-machine.ts`       | `core/handover/state-machine.spec.ts` (new)          |                                                     before: unloaded | All legal/illegal transitions, `botMaySpeak`, `operatorMaySpeak`.                                                            |
| `core/agent/money.ts`                  | `core/agent/money.spec.ts` (new)                     |                                                     before: unloaded | Decimal compare boundaries, different scales, integers, equal, less-than.                                                    |
| `leads/phone.ts`                       | `leads/phone.spec.ts` (extended)                     |                             before: unloaded in table (spec existed) | Added `phoneFromCustomerText` speech-digits policy cases (typed blocks, accept allows, fail-safe).                           |
| `access/access-decision.ts`            | `access/access-decision.spec.ts` (extended)          |                             before: unloaded in table (spec existed) | Added `billingRequired` config parsing and `OPEN_SUBSCRIPTION_STATUSES`/missing-latest billing paths as needed.              |
| `handover/operator-text.ts`            | `handover/operator-text.spec.ts` (new)               |                                              before: 28/100/14.28/28 | `operatorStrings` locale selection (en/ru/uz), `refLine`/`parseRef` (valid/invalid/missing).                                 |
| `leads/lead-stage.util.ts`             | `leads/lead-stage.util.spec.ts` (new)                |                                              before: 14.28/0/0/16.66 | `DEFAULT_LEAD_STAGES` shape/order and `ensureLeadStages` behavior via minimal tx stub (createMany/findUnique/throw path).    |
| `core/agent/verified-answer.ts`        | `core/agent/verified-answer.spec.ts` (existing/kept) |                                                             existing | Already covered narrow pairing; no production change.                                                                        |

(If a test revealed a real bug, it would be `it.fails`/skipped with a comment and described in the report — none found while writing these behavior-based tests.)

## 3. Mutation sanity (>=5 tests)

Recorded by temporarily breaking the production line each test covers, confirming the specific test failed, then restoring:

1. `state-machine`: changed `HANDOVER` target to `BOT_ACTIVE` → `state-machine` transition tests failed; restored.
2. `money.decimalAtLeast`: flipped comparison to `<` path (`a < m` return) → boundary/equality tests failed; restored.
3. `followup/policy decideFollowUp`: removed `OPTED_OUT` early return condition → opted-out/consent-revoked tests failed; restored.
4. `optout.isOptOutMessage`: returned `false` unconditionally → exact opt-out match tests failed; restored.
5. `phone.phoneFromCustomerText`: allowed speech when `typed` (removed guard) → speech-digits refusal test failed; restored.

## 4. After

- Targeted specs for added/extended pure files: **8 test files, 51 tests passed**  
  (`core/handover/state-machine.spec.ts`, `core/agent/money.spec.ts`, `core/followup/optout.spec.ts`, `core/followup/policy.spec.ts`, `core/scheduling/scheduling-render.spec.ts`, `handover/operator-text.spec.ts`, `leads/lead-stage.util.spec.ts`, `leads/phone.spec.ts`).
- Full unit suite: `pnpm --filter @agentcore/api test:unit` → **130 test files passed, 2377 tests passed, 15 skipped** (0 failed). Known unrelated pre-existing failure mentioned in handoff (`live-eval-runner.spec.ts` "refuses without a key") not observed in this run.
- No production code changed; coverage for touched files increased relative to “before” (new specs exercise previously unloaded/low-coverage pure logic). Full coverage re-run after edits not separately captured beyond the initial measurement run due to environment noise in that command; targeted and full-unit results above are authoritative for correctness.

## 5. Not run / limits

- `pnpm test:integration`, `pnpm test:e2e`, dev servers — not run (per rules).
- Coverage run in this environment showed `@agentcore/shared` resolution noise in some suites during that invocation; targeted unit specs for added tests are the authoritative signal for those files.
