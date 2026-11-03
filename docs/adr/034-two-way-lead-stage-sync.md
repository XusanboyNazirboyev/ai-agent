# ADR 034: Two-way lead stage sync with the CRM (Bitrix24 first)

- **Status:** Proposed, 2026-11-03. Not accepted: the open questions below are the owner's to decide. ADR 033 (video knowledge, branch `docs/video-knowledge`) holds number 033.
- **Date:** 2026-11-03
- **Inputs:**
  - ADR 032 (connect Bitrix24 from the web; stage sync deferred to "a later slice with its own ADR");
  - ADR 023 (connector writes: one logical write, one idempotency key, typed outcomes);
  - the Bitrix24 connector on `main` (`apps/api/src/connectors/bitrix24/`);
  - D8, D9, D11, D16; rules 1, 3 and 7 of `AGENTS.md`.

## Owner decisions (2026-11-02)
1. **Meaning:** "voronka" means the **lead stages**, not deal pipelines.
2. **Two-way:** a stage change on either side is copied to the other. If both sides changed, the latest change wins and the loss is recorded.
3. **Mapping:** the CRM's own stages are mapped to tezda's four lead statuses (`NEW`, `IN_PROGRESS`, `WON`, `LOST`) by a table on the CRM page. The lead board in tezda keeps its four columns.

## Context
- **Today** (ADR 032, connector on `main`): a lead is created in Bitrix24 once (`createLead`, `updateLead: false`) and never touched again.
  - A status change in tezda (operator command or web) stays in tezda.
  - A stage change in Bitrix24 never reaches tezda.
- **Connection type:** the tenant connects Bitrix24 with an **incoming webhook**. Bitrix24 lets only applications subscribe to events (`event.bind` returns `WRONG_AUTH_TYPE` for webhooks), so tezda cannot subscribe itself.
- **Defect found:** every lead is labelled `sourceDescription: 'tezda (Telegram)'`, also those from Instagram. It is fixed in slice 1.

## What the official Bitrix24 docs say (apidocs.bitrix24.com, read 2026-11-02/03; the pages show no dates)
- **Lead stages** ([crm.status.list](https://apidocs.bitrix24.com/api-reference/crm/status/crm-status-list.html)): lead stages are the directory with `ENTITY_ID: "STATUS"`, as named on the crm.item.update page.
  - **Fields returned:** `STATUS_ID`, `NAME`, `SORT`, `SEMANTICS` and `EXTRA`.
  - **`SEMANTICS` values:** `S` is a successful stage, `F` a failed stage, and `null` a stage in progress. `EXTRA.SEMANTICS` gives `process`, `success`, `failure` or `apology`.
- **Changing a stage** ([crm.item.update](https://apidocs.bitrix24.com/api-reference/crm/universal/crm-item-update.html), `entityTypeId: 1`): set field `stageId`.
  - Mandatory fields are checked when the stage changes within the pipeline.
  - A stage change can fail with HTTP 400 "Insufficient permissions to change the stage".
  - A save with no changed value is not performed.
  - **Unverified:** whether moving a lead to the success stage by API needs a lead conversion.
- **Reading changes** ([crm.item.list](https://apidocs.bitrix24.com/api-reference/crm/universal/crm-item-list.html)):
  - filters take `>` and `>=` prefixes (the example is `>=createdTime`);
  - pages are fixed at 50 items, paged with `start`; `order` takes `ASC` or `DESC`.
  - **Unverified:** that `updatedTime` is filterable (to confirm with `crm.item.fields`).
- **Events** ([overview](https://apidocs.bitrix24.com/api-reference/events/index.html), [onCrmLeadUpdate](https://apidocs.bitrix24.com/api-reference/crm/leads/events/on-crm-lead-update.html)):
  - **Delivery:** through a queue, possibly late. A failed delivery is logged and **not resent**.
  - **Offline queue:** only for applications and administrators.
  - **Outbound webhook:** an admin can create one in the portal (Developer resources > Other > Outbound webhook) with a handler URL. An "Application token" is generated for it.
  - **Payload:** `onCrmLeadUpdate` carries `data.FIELDS.ID` and `auth.application_token`.
  - **Unverified:** whether a stage change alone fires the event.
- **Checking a handler call** ([security](https://apidocs.bitrix24.com/api-reference/events/safe-event-handlers.html)): compare the stored token with `auth.application_token` and answer `403` on a mismatch. The token must never be logged.

## Decision (proposed)
**1. Generic in core, Bitrix24-specific in the connector (rule 1, D8, D9).**
- **New capabilities:** `ConnectorCapabilities` gains `leadStages` (list the CRM's stages) and `updateLeadStage` (set one lead's stage).
- **Change detection:** a third operation, `changedLeads(since)`, returns canonical `{ crmLeadId, stageId, changedAt }`.
- **Core never sees Bitrix24 names.** It stores the CRM stage id as an opaque string and works with the four canonical statuses through the tenant's mapping.

**2. The mapping table (owner decision 3).**
- **Where it lives:** the CRM page reads the CRM's stages and shows one row per stage with the tezda status it means. It is stored in the tenant connector's config.
- **Default proposal:**
  - `SEMANTICS S` maps to `WON`, and `F` to `LOST`;
  - the first in-progress stage by `SORT` maps to `NEW`, the other in-progress stages to `IN_PROGRESS`.
- **Direction tezda → CRM:** each tezda status has one **target stage** (by default the first stage mapped to it). The admin can change it.
- **When stages change in the CRM:** a stage added or removed later shows as "not mapped". Sync for a lead in an unmapped stage stops and is shown, never guessed.

**3. tezda → CRM.**
- **Trigger:** a status change of a lead that already has a `crmLeadId` writes a durable outbox row (the same transaction as the status change).
- **Write:** a job calls `updateLeadStage` with the mapped target stage. It is one logical write per change with its own idempotency key (ADR 023), so a retry never sets an older stage over a newer one.
- **Refusal:** a refused change (mandatory fields, permissions) is marked on the lead and shown to the operator; the tezda status is kept.

**4. CRM → tezda: polling is the source of truth, the webhook only makes it faster.**
- **Polling:** per connected tenant, a scheduled job asks for tezda's leads changed since the last check. It uses `>=updatedTime` if verified, otherwise the agreed fallback.
  - For each changed lead whose stage differs from the last synced stage, the mapped status is applied in tezda.
- **Optional outbound webhook:** the admin may add one in the portal and paste its application token on the CRM page. The token is stored encrypted in `connector_secrets` (purpose `bitrix24_outbound_token`).
  - The handler checks the token in constant time, answers `403` on a mismatch, and is rate limited.
  - It uses only the lead id from the payload. Payloads are untrusted data (D16), so the job re-reads the lead from the API before acting.
  - Lost events are caught by the next poll.
- **Only tezda's leads are read:** those with a stored `crmLeadId`. Other CRM leads are never imported.

**5. Conflicts: the latest change wins (owner decision 2).**
- **What is stored per lead:** the last synced CRM stage, the time of the last sync, and the time of the last local status change.
- **Both sides changed since the last sync:** the later of the local change time and the CRM's `updatedTime` wins. Both are stored as UTC instants; the CRM time is the CRM's own clock.
- **The losing side** is overwritten. The loss is written to the lead's history (who, from, to, when) and audited without customer text.

**6. Not changed.**
- Lead creation, duplicate handling and the local lead stay as in ADR 032.
- A CRM failure never hides or deletes the local lead.
- Leads only; deals are out of scope (owner decision 1).

## Open questions (none assumed)
| # | Question | Blocks |
|---|---|---|
| S1 | Live read-only checks on a test portal (live calls need explicit approval): `updatedTime` filterable; stage change by `crm.item.update` on a success stage without conversion; whether a stage change fires `onCrmLeadUpdate`. | Slice 1 |
| S2 | Polling interval (proposal: 2 minutes) and the Bitrix24 request budget per tenant. | Slice 1 |
| S3 | When the operator's change is refused by the CRM (mandatory fields), keep the tezda status with a warning (proposed), or roll it back? | Slice 1 |
| S4 | Is the outbound webhook wanted in the first slice, or polling only? | Slice 2 |
| S5 | A test Bitrix24 portal (with its admin) for the live checks and the demo. | Slice 1 |

## Consequences
- **Gain:** operators can work in either tezda or Bitrix24, and the lead stage stays the same on both sides within the polling interval.
- **Every connector:** a CRM needs the three new operations to take part. A connector without them keeps today's one-way creation.
- **Cost:** Bitrix24 is polled continuously while a tenant is connected. The request budget is S2.
- **Correctness:** a portal's clock decides some conflicts (the CRM's `updatedTime`), so the rule is "latest by each side's own clock". This is stated on the CRM page.

## Alternatives considered
- **Webhook only:** rejected. Bitrix24 does not resend failed events.
- **A Bitrix24 application with offline events:** reliable, but it needs an app in the Bitrix24 marketplace or a local app with OAuth. It is a larger change of the connect flow (ADR 032), so it is left for later.
- **Showing the CRM's own stages in tezda:** rejected by the owner (decision 3).
