# AgentCore audit task board

Last updated: 2026-11-12

This file tracks the focused audit-remediation backlog discussed with the project owner.
It is a coordination aid, not a replacement for issue tracking or Claude Code's validation report.

## Status rules

- **OPEN** — not implemented.
- **IN PROGRESS** — investigation or implementation is active.
- **IMPLEMENTED / VALIDATION PENDING** — code is prepared; Claude Code must review and run the relevant tests.
- **PARTIAL** — some remediation exists, but the original finding is not fully closed.
- **BLOCKED / NEEDS EVIDENCE** — cannot be closed without deployment/runtime/owner-approved evidence.
- **CLOSED** — implementation and required validation have been confirmed.

ChatGPT prepares code and tests only. Claude Code owns review, local test execution, CI, push, merge, deployment and runtime verification. No task is CLOSED merely because code was authored.

## Active audit backlog

| ID | Priority | Finding | Current status | Next action |
|---|---|---|---|---|
| AUD-01 | P0 | Waiting inbox is not globally longest-wait-first; page sorting and cursor ordering disagree | IMPLEMENTED / VALIDATION PENDING | Review SQL, run the new integration spec and API typecheck; verify pagination/filter behavior |
| AUD-02 | P0 | Conversation timeline can omit newest messages when more than 500 exist | IMPLEMENTED / VALIDATION PENDING | Review and run the 501-message integration regression test |
| AUD-04 | P1 | Instagram account, secret and audit writes are not fully atomic | PARTIAL | Trace all connect/callback/disable/disconnect transaction boundaries; add rollback and concurrency tests |
| AUD-06 | P1 | Graceful shutdown lifecycle is only partially covered | PARTIAL | Inventory every worker, queue, SSE stream, provider and DB resource; implement ordered/idempotent shutdown and tests |
| AUD-07 | P1 | Deployment image and source HEAD cannot be reproduced/verified reliably | BLOCKED / NEEDS EVIDENCE | Define immutable image digest + embedded commit SHA; Claude verifies deployed runtime against expected SHA |
| AUD-08 | P0 | SSE response backpressure is uncontrolled | IMPLEMENTED / VALIDATION PENDING | Review bounded queue/drain/slow-client close behavior and run its integration regression test |
| AUD-09 | P1 | Knowledge-only tenant cannot operate without a catalog connector | OPEN | Trace tenant capability resolution and tool registration; add catalog-free knowledge-only tests |
| AUD-11 | P1 | Delayed mutation in conversation A can clear draft in conversation B | IMPLEMENTED / VALIDATION PENDING | Review active-conversation guard and run frontend regression test |
| AUD-12 | P1 | SSE JSON events lack runtime schema validation | OPEN | Define discriminated event schemas and validate at the event boundary; test malformed/unknown payloads |
| AUD-13 | P1 | Connector selection may choose the oldest active search connector instead of configured source | OPEN | Trace tenant connector configuration and routing; make source selection explicit and deterministic |
| AUD-14 | P1 | DomainPack requires search_catalog, preventing catalog-less packs | OPEN | Separate optional catalog capability from required pack contract; add scheduling/knowledge-only pack tests |

**Count:** 11 audit items remain not fully closed. Three have code prepared from earlier work (AUD-02, AUD-08, AUD-11); AUD-01 is now implemented on its own branch but awaits Claude Code validation. AUD-04 and AUD-06 remain partial. AUD-07 needs runtime evidence. The remaining four are open.

## ChatGPT implementation branches

All branches below are intentionally isolated and must not be blindly merged. Claude Code should inspect each branch diff and integrate changes sequentially.

| Task | Branch | Known commit(s) | Files / integration note |
|---|---|---|---|
| AUD-01 | `fix/inbox-waiting-order-2026-11-12-chatgpt` | `69ac89a`, `8549c64`, `cb860c4` | `apps/api/src/webinbox/inbox-read.service.ts`; new `inbox-waiting-order.integration.spec.ts` |
| AUD-02 | `fix/inbox-latest-500-2026-11-12-chatgpt` | `55c45f1`, `32111de` | `inbox-read.service.ts` and `webinbox.integration.spec.ts` |
| AUD-08 | `fix/sse-backpressure-2026-11-12` | Re-check exact HEAD before integration | `events.controller.ts` and `webinbox.integration.spec.ts` |
| AUD-11 | `fix/conversation-draft-ownership-2026-11-12` | `964870f` | `apps/web/src/components/conversation-view.tsx` |

### Known integration collision

AUD-02 and AUD-08 both modify `apps/api/src/webinbox/webinbox.integration.spec.ts`. Do not merge blindly. Integrate one branch, then manually reconcile the second test addition against the updated file. AUD-01 avoids this collision by adding a dedicated integration spec file.

## Current resume pointer

- **Current task:** AUD-01 — global waiting queue ordering and keyset pagination.
- **Current branch:** `fix/inbox-waiting-order-2026-11-12-chatgpt`.
- **Latest branch HEAD:** `4bea0c5b43a54c729e3cd88f1c656402818cad9a` (task-board documentation).
- **Last implementation commit:** `cb860c481112c1af57a821cc0ad2d13fad97fe82`.
- **Implementation:** waiting candidates are filtered and sorted in PostgreSQL by `COALESCE(MIN(active handover.opened_at), conversation.updated_at)`, then by UUID text; the cursor uses the same ascending composite order. Full rows are fetched only for the selected page and restored to candidate order.
- **Regression coverage authored:** three conversations with staggered handover times, two-page traversal, no duplicate/missing IDs.
- **Validation:** NOT RUN by ChatGPT. Claude Code must review and run it.
- **Next task after AUD-01:** AUD-12 — SSE event runtime schema validation (kept separate from AUD-08's already-authored SSE backpressure work).

## Handoff protocol

When resuming, read this file first, verify the current branch HEAD and working tree, then continue from the **Current resume pointer**. Update this file only when task state or resume pointer changes. Never mark tests, CI, deployment or runtime verification as successful without actual evidence.
