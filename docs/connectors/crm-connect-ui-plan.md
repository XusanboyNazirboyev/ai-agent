# CRM connect from the web (Bitrix24) — plan

Status: planned, not built (2026-11-02). Branch for the work: `feat/dev-mock-connector`.

## Owner decisions (2026-11-02)
1. **Scope of slice 1:** a "CRM integration" page that connects **Bitrix24** with its incoming-webhook URL, using the existing connector capability (create lead). Looking a customer up by phone and reporting the deal stage is a **later slice** (new agent tool, needs its own ADR).
2. **Storage:** a new table `connector_secrets` (Prisma migration approved), encrypted with the existing `SecretCipher`, separate from `channel_secrets`.
3. **No learnX card** on the page.

## What exists today (verified on `8718995`)
- `apps/api/src/connectors/bitrix24/`: connector (createLead only), 7-method allow-list, `parseWebhookUrl` (https, `/rest/<digits>/<code>/`, no query or credentials), `crm.settings.mode.get` check (mode 2 = simple CRM → `BITRIX24_LEADS_DISABLED`).
- The webhook URL is read only through `webhookSecretRef` (`env:CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL`); there is no per-tenant storage and no web API or page for connectors.
- `channel_secrets` + `SecretCipher` (ADR 028) are tied to channel accounts.
- Lead routing stopgap: the oldest active connector that can create leads wins; the mock needs `createLead: false` (DEF-015).

## Design (slice 1)
- **Migration `connector_secrets`:** `tenantId`, `tenantConnectorId` (composite FK to `tenant_connectors`), `purpose`, `keyId`, `nonce`, `ciphertext`, timestamps; unique `(tenantId, tenantConnectorId, purpose)`; AAD `tenant:connector:purpose`. Additive only.
- **Secret resolution:** a store-backed ref (e.g. `store:bitrix24_webhook_url`) beside the existing `env:` refs in the connector registry, resolved per tenant connector; never logged or returned.
- **API (OWNER/ADMIN, session + CSRF, rate-limited, audited without values):**
  - `GET /api/v1/connectors`: key, status, capabilities, `configured` (never the URL).
  - `POST /api/v1/connectors/bitrix24` `{ webhookUrl }`: `parseWebhookUrl`, then `crm.settings.mode.get` through the existing client; on success store encrypted, create or activate the tenant connector, and set the mock connector's `createLead: false`; map failures to codes (invalid URL, unreachable, rejected, leads disabled).
  - `POST /api/v1/connectors/:id/disable` and `DELETE /api/v1/connectors/:id` (removes the secret).
- **Web:** page "CRM integratsiyasi" (Settings area), modelled on the reference screenshot: Bitrix24 card (where to create the incoming webhook with the `crm` scope, URL input as a password field, "Ulash va tekshirish"), "Ichki CRM" card (active), amoCRM and HubSpot "Tez orada". Strings in uz-Latn, ru, en; layout gate 320–1920 px.
- **Tests:** URL validation unit tests; integration (store round trip, tenant isolation, URL never in responses, logs or audit, mode-2 refusal); e2e with a fake Bitrix24 (needs a test-only base-URL override, refused in production, like `INSTAGRAM_API_BASE_URL`).
- **Docs:** ADR 028 amendment or ADR 032 (connector secrets from the web), DEFECTS DEF-015 note, PROGRESS.

## Not in slice 1
Phone lookup and deal stage for the agent; amoCRM; HubSpot; learnX.
