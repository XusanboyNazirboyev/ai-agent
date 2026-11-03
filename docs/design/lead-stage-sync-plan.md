# Plan: two-way lead stage sync (Bitrix24 first)

Design and open questions: [ADR 034](../adr/034-two-way-lead-stage-sync.md) (Proposed). Each slice is one branch, merged only after its acceptance passes and the owner approves the merge.

## Slice 0: verify on a test portal (no product code)
- **Blocked by:** S1, S5. Live calls need explicit approval.
- **Read-only checks, then one test lead:**
  - the `STATUS` stages and their `SEMANTICS`;
  - whether `>=updatedTime` filters `crm.item.list`;
  - setting `stageId` on a test lead, including a success and a failed stage;
  - whether a stage change fires `onCrmLeadUpdate` through an outbound webhook.
- **Output:** a report in `docs/evidence/` with no webhook URL, token or customer data.
- **Done when:** each unverified point of ADR 034 is confirmed, or the design is changed.

## Slice 1: tezda → CRM and polling (backend)
- **Blocked by:** slice 0, S2, S3.
- **Migration:** additive, owner approval needed. Per lead: last synced CRM stage, last sync time, last local status change time.
- **Connector:**
  - `leadStages`, `updateLeadStage`, `changedLeads(since)` on the interface;
  - the Bitrix24 implementation;
  - the fake portal extended for them.
- **Mapping:** stored in the connector config, with the default from stage semantics and an "unmapped" state.
- **Outbox:** a status change writes a row; a job writes the stage (idempotent, typed outcomes, ADR 023).
- **Polling job:** applies CRM changes with the latest-wins rule, history and audit.
- **Fix:** the lead source text follows the channel (Telegram or Instagram).
- **Tests:**
  - unit: mapping defaults, conflict rule with fixed clocks;
  - integration: tenant isolation, a refused stage change, an unmapped stage, a retry does not overwrite a newer stage, polling idempotency.

## Slice 2: web, and the optional outbound webhook
- **CRM page:**
  - the mapping table (one row per CRM stage, a status select, the target stage per status);
  - an "unmapped" warning;
  - the last sync time.
- **Lead view:** a sync error or a conflict note on the lead.
- **Outbound webhook** (if S4 says yes):
  - a token field on the CRM page (stored encrypted);
  - the handler endpoint with a constant-time token check, `403` on mismatch and a rate limit;
  - a job that re-reads the lead.
- **Strings and tests:** en, ru, uz-Latn; e2e against the fake portal; layout and a11y sweeps.
