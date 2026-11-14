# 04 — Connector outage (CRM or catalog system)

A tenant has up to three connector roles (ADR 059): `CATALOG` (product, price and availability answers), `LEAD_SINK` (new leads go to the CRM, today Bitrix24) and `ACTIONS` (write actions such as bookings). Each role is bound to one connector; there is no silent fallback to another one.

## What the customer and the team see
- **Catalog down or unbound:** the agent cannot get facts, so it hands the conversation to a human with reason `NO_DATA` (prices and availability only ever come from the connector, never from model memory, D1). A tenant whose pack also offers `knowledge_search` and runs the knowledge-only turns (ADR 060, once released) still answers plain knowledge questions.
- **Lead sink down:** leads are saved in tezda first. The CRM copy retries with backoff up to the attempt limit, then the lead shows a failed CRM state and the failure is counted by the alert (`ALERT_CRM_FAILURES_PER_HOUR`). Nothing is lost; the CRM just does not have it yet.
- **Settings, CRM** shows the roles with a badge: `BOUND`, `UNBOUND`, `AMBIGUOUS` (two candidates, nothing chosen: fail closed) or `UNAVAILABLE` (bound but its configuration does not load or it is not active).

## Steps
1. Open Settings, CRM, "Connector roles". `UNAVAILABLE` means the bound connector is inactive or misconfigured: reconnect it on the same page (the Bitrix24 webhook URL may have been revoked or the portal disabled "leads").
2. If the CRM vendor is down, do nothing to the data: retries continue. Check the vendor status page and tell the tenant.
3. Host side, to read the reason (no secrets are logged): `dc logs --since 30m api | grep -E 'connector\.|crm_sync'` shows `connector.bound_unavailable`, `connector.ambiguous`, `lead.crm_sync_failed` with a code such as `CONNECTOR_NETWORK_FAILURE`, `CONNECTOR_REQUEST_FAILED` or `BITRIX24_INVALID_CREDENTIALS`.
4. After the CRM is back, failed leads are retried by the scheduler; an operator can also resend one from the lead (ADR 037). A lead whose outcome was unclear (`UNCERTAIN`) is never retried blindly (ADR 023): check the CRM by hand for a duplicate first.
5. Two connectors able to serve one role and nothing bound (`AMBIGUOUS`): bind one explicitly in "Connector roles".

## Verify
The role badge is `BOUND`, a test conversation gets a catalog answer, a new test lead appears in the CRM within a minute, and the failed-sync counter stops growing.

## Known limits
No automatic vendor status checks. The catalog sync job refuses two connectors syncing the same source system (`CATALOG_SYNC_SOURCE_CONFLICT`); that is deliberate.
