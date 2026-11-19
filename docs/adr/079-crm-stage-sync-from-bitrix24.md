# ADR 079 — Lead stages follow the connected CRM (Bitrix24 first)

Status: accepted for slice 1 (2026-11-19). Owner request 2026-11-19: "when we connect the assistant to another CRM and they change the funnel stages there, our funnel should change automatically too." Which other CRMs the owner's customers use is open (Q-CRM below); slice 1 covers Bitrix24, the only CRM connector we have.

## Context
- The Bitrix24 connector (connect from the web: Settings → CRM, stored per tenant in `connector_secrets`) only **writes**: a lead we create is pushed to the portal through `crm.item.add`; the Bitrix24 lead id is kept in `connector_operations.external_id` for our lead (ADR 023 operation records).
- Nothing reads changes back, so a lead moved in Bitrix24 stays where it was on our board.

## Facts checked (official docs, read 2026-11-19)
- `crm.item.list` with `entityTypeId: 1` (leads) returns `stageId`; filters take operators such as `>=` on time fields; pages are fixed at 50 rows (`start`). <https://apidocs.bitrix24.com/api-reference/crm/universal/crm-item-list.html>
- `crm.status.list` lists stages with `STATUS_ID`, `NAME`, `SORT`, `SEMANTICS` (`process`, `success`, `failure`, `apology`); `ENTITY_ID` filter must be a string. <https://apidocs.bitrix24.com/api-reference/crm/status/crm-status-list.html>
- Outbound webhooks send `ONCRMLEADUPDATE` with only `data.FIELDS.ID`; the handler must compare `auth.application_token` with the token shown in the webhook form and answer 403 on mismatch. <https://apidocs.bitrix24.com/api-reference/crm/leads/events/on-crm-lead-update.html>, <https://apidocs.bitrix24.com/api-reference/events/safe-event-handlers.html>, <https://apidocs.bitrix24.com/local-integrations/local-webhooks.html>
- Not verified on a live portal: the `ENTITY_ID` value for lead statuses (`STATUS` expected), the `updatedTime` filter on leads, and the body encoding of outbound webhooks. A live check on the owner's portal is required before calling this done.

## Decision (slice 1)
- **Polling, not webhooks, first.** A scheduled scan (every 2 minutes per Bitrix24 connector with stage sync on) asks `crm.item.list` for leads with `>=updatedTime` since its saved cursor (minus a one-minute overlap), selecting `id`, `stageId`, `updatedTime`. No setup on the customer's side beyond what connecting already needs, which keeps it simple enough for a non-technical owner (owner request 6). Outbound webhooks for instant updates are slice 2 (they need a public handler and a token per portal).
- **Stage mapping per connector.** Settings → CRM → Bitrix24 shows the portal's lead stages (`crm.status.list`) next to a select of our stages in the pipeline the connector feeds. Defaults: `success` → our WON stage, `failure`/`apology` → our LOST stage, `process` stages → unmapped (ignored) until the admin picks one. Stored in a new table `crm_stage_mappings` (tenant, tenant connector, external stage id, our stage id), additive migration with an RLS tenant policy like the other tenant tables.
- **Applying a change.** For each changed Bitrix24 lead, find our lead through the `SUCCEEDED` create-lead operation with that `external_id`; skip leads we do not know, archived leads, unmapped stages, and leads already in the mapped stage. Move through `moveLeadToStage` (same rules as a manual move); a LOST move gets the reason "Bitrix24: <stage name>". The lead is marked as set by a person, not the AI (`stageSetBy` OPERATOR), and the audit row `lead.stage.changed` records `source: 'bitrix24'` and the external stage id, never portal URLs or tokens.
- **No loop.** We do not write stages to Bitrix24 today, so a change cannot echo back. If two-way sync is added later, it must skip changes whose `updatedTime` matches our own last write.
- **Methods.** `crm.status.list` is added to the connector's allow-list (read only); `crm.item.list` is already allowed.
- **Failures.** Portal errors back off per connector (existing resilience wrapper); a revoked webhook marks the connector as needing attention on the CRM page, as connect errors do today.

## Not in slice 1
Bitrix24 deals (`entityTypeId 2`, pipelines by `CATEGORY_ID`) and converted leads; outbound-webhook instant updates; amoCRM and other CRMs (Q-CRM); writing our stage changes to Bitrix24.

## Open
- **Q-CRM (owner):** which CRMs do your customers use: Bitrix24 leads, Bitrix24 deals, amoCRM, something else? It decides slice 2.
