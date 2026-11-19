# ADR 081 — amoCRM connector: leads out, stages back

Status: accepted (2026-11-19). Owner request 2026-11-19: "if the Bitrix integration is finished, integrate amoCRM too." Same two directions as Bitrix24: every new lead goes to amoCRM, and a stage changed in amoCRM moves the lead on our board (ADR 079).

## Facts checked (official docs, read 2026-11-19)
- **Access:** a private integration in the amoCRM account can issue a **long-lived token** (since February 2024; the user picks 1 day to 5 years; no refresh token; revocable under "Issued access"). Every request sends `Authorization: Bearer <token>` to `https://<subdomain>.amocrm.ru`. <https://www.amocrm.ru/developers/content/oauth/step-by-step> (section "Долгосрочные токены")
- **Leads:** `GET /api/v4/leads` (`limit` up to 250, `page`, `order[updated_at]=asc`, filters such as `filter[updated_at][from]=<unix>` and `filter[pipeline_id][]`); each lead has `status_id` and `pipeline_id`. `POST /api/v4/leads/complex` adds leads with their contact, at most 50 per request. <https://www.amocrm.ru/developers/content/crm_platform/leads-api>, <https://www.amocrm.ru/developers/content/crm_platform/filters-api>
- **Pipelines and stages:** `GET /api/v4/leads/pipelines` with `_embedded.statuses` (`id`, `name`, `sort`, `type`: 1 = unsorted, 0 = normal). Every pipeline has system stages 142 ("successfully realised") and 143 ("closed and not realised"). <https://www.amocrm.ru/developers/content/crm_platform/leads_pipelines>
- **Limits:** at most 7 requests a second per integration and 50 per account; above it HTTP 429, and repeated violations block the account (403 on every request). Lists return at most 250 entities; writes are recommended at 50 or fewer. <https://www.amocrm.ru/developers/content/api/recommendations>
- To be read by the builder before coding and cited in the implementation notes: the contact phone field format in `leads/complex` (contacts API), and `GET /api/v4/account` for checking a token.
- Not verified on a live account: everything above; a live check on a real amoCRM account is required before calling this done.

## Decision
- **Connect from the web** (Settings → CRM, OWNER/ADMIN), like Bitrix24: the account subdomain (`^[a-z0-9-]{1,63}$`, host fixed to `<subdomain>.amocrm.ru`; other domains such as kommo.com are not accepted in this slice) and the long-lived token, stored encrypted in `connector_secrets` (never returned, logged or audited). Connecting checks the token with one read and maps failures to codes (invalid, unreachable, rejected). The page explains in plain words where to create the private integration and the token.
- **Which pipeline:** after connecting, the admin picks the amoCRM pipeline our leads go to (from `leads/pipelines`); new leads start in its first normal stage.
- **Leads out:** the connector implements `createLead` through `leads/complex` (lead name, contact name and phone), through the existing lead sync operation records (ADR 023), so retries are idempotent and the amoCRM lead id lands in `connector_operations.external_id`, as for Bitrix24. Only one CRM connector creates leads at a time (the existing routing rule).
- **Stages back:** the stage sync of ADR 079 becomes connector-neutral: a small source interface (`listStages()`, `listChangedLeads(since, page)`) implemented by Bitrix24 and amoCRM, one scan, the same `crm_stage_mappings` table and Settings section. amoCRM defaults: 142 → our WON stage, 143 → our LOST stage (reason "amoCRM: <stage name>"), other stages unmapped until chosen; only the chosen pipeline is polled (`filter[pipeline_id]`), with `filter[updated_at][from]` = cursor − 60 s, `order[updated_at]=asc`, 250 per page, at most 500 per run.
- **Rate limit:** an amoCRM client never sends more than 5 requests a second per connector (below the 7 allowed), backs off on 429 and stops the connector's run on 403, recording the code for the CRM page.
- **Security:** fixed host, HTTPS only, no redirects followed, method allow-list like the Bitrix24 client; amoCRM text is untrusted data.

## Not in this slice
OAuth app for the amoCRM marketplace, kommo.com accounts, webhooks for instant updates, writing our stage changes to amoCRM, tasks and notes in amoCRM, the agent reading amoCRM as a catalog.

## Implementation notes (2026-11-19)
Docs read with `tvly extract` on 2026-11-19 (all official, www.amocrm.ru/developers/content/):
- `crm_platform/account`: `GET /api/v4/account`, available to every user; used to check the token (answer needs a numeric `id`).
- `crm_platform/leads-api`: `POST /api/v4/leads/complex` body is an array; `name`, `status_id`, `pipeline_id`, `request_id`, `_embedded.contacts[]`; answer is an array with `id`, `contact_id`, `request_id[]`, `merged`. `GET /api/v4/leads`: `page`, `limit` (max 250), `order[updated_at]=asc`.
- `crm_platform/contacts-api` and the complex example: phone is `custom_fields_values: [{ field_code: "PHONE", values: [{ enum_code: "WORK", value: "+7..." }] }]`.
- `crm_platform/filters-api`: `filter[updated_at][from]=<unix>` and `filter[pipeline_id][0]=<id>`.
- `crm_platform/leads_pipelines`: `_embedded.pipelines[]` with `is_main`, `is_archive`, `_embedded.statuses[]` (`type` 1 unsorted, 0 normal; ids 142/143).
- `api/recommendations`: 429 over the limit, 403 after repeated violations, 402 unpaid account.

Decisions: no migration (the chosen pipeline lives in the connector config `pipelineId`; the existing stage-sync tables are reused; no new tenant table, so no new RLS policy). Write idempotency is `none`: the docs show no lookup by our key, so an unclear create is never repeated automatically; the key is sent as `request_id` only. Rate gate is shared per subdomain (200 ms); 429 retried with the shared `retryWithBackoff`; 403 blocks the subdomain for 10 minutes and the run records `AMOCRM_FORBIDDEN`. Lead summary and slots are not written (notes API is outside the allow-list); only name, contact name and phone. The unsorted inbox stage (`type` 1) is not offered for mapping. Pipeline change deletes that connector's stage mappings. Web check seam: `AMOCRM_CONNECT_TRANSPORT` (no env base URL yet; no Playwright flow for amoCRM).

Not verified (no live account): real response shapes against a live account, `204` with an empty body for an empty lead list (handled defensively, not in the docs read), `filter[pipeline_id][0]` array syntax and `request_id` behaviour on a live account, the token Bearer scheme on `*.amocrm.ru` for long-lived tokens, duplicate-control merging (`merged`) on `leads/complex`.
