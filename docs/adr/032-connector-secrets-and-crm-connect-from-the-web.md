# ADR 032: Connector secrets and connecting a CRM from the web (slice 1: Bitrix24)

- **Status:** Accepted by the owner on 2026-11-02 (plan `docs/connectors/crm-connect-ui-plan.md` on branch `feat/dev-mock-connector`, owner decisions 1–3). Slice 1 is implemented on branch `feat/crm-connect-ui`.
- **Date:** 2026-11-02
- **Inputs:** the plan above; ADR 028 (channel secrets and `SecretCipher`); the Bitrix24 lead-sink connector on `main` (`apps/api/src/connectors/bitrix24/`); DEF-015 (lead routing).

## Context
- The Bitrix24 connector read its incoming-webhook URL only through `env:CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL`: one deployment-wide value, set by hand, with no per-tenant storage and no web page.
- The owner decided (2026-11-02):
  1. Slice 1 is a "CRM integration" page that connects Bitrix24 with its incoming-webhook URL, using the existing capability (create lead). Looking a customer up by phone and reporting the deal stage are a later slice with their own ADR.
  2. Storage is a new table `connector_secrets` (migration approved), encrypted with the existing `SecretCipher`, separate from `channel_secrets`.
  3. No learnX card on the page.

## Decision
**1. `connector_secrets`** (migration `20261107090000_connector_secrets`, additive): tenant, tenant connector (composite FK to `tenant_connectors`, cascades), purpose, key id, nonce, ciphertext and timestamps; unique per connector and purpose.
- **Store:** `PrismaConnectorSecretStore` uses the same cipher and keyring as channel secrets (`SECRETS_MASTER_KEY`, rotation through `SECRETS_KEY_ID` and `SECRETS_PREVIOUS_KEYS`). Its associated data is `connector:<tenant>:<connector>:<purpose>`. The `connector:` prefix keeps it apart from channel secrets, so a value copied to another row, tenant or table does not decrypt.
- **Version:** `read()` also returns a version that changes on every replacement.

**2. `store:` references.** A connector config may reference a secret as `store:<purpose>` (the shared `SecretRefSchema` already allows the scheme); the only purpose so far is `bitrix24_webhook_url`.
- **Loader:** `TenantConnectorLoader.create` (now async) reads, for every such reference in the row's config, that row's own secret, and hands it to the registry.
- **Fallback:** a `store:` reference never falls back to the environment or to another tenant. Without a store or a value, the connector fails closed with `CONNECTOR_SECRET_MISSING`.
- **Cache:** the secret's version is part of the registry's cache fingerprint, so a reconnect rebuilds the cached connector.

**3. API** (`ConnectorsController`): OWNER/ADMIN, CSRF through the session guard, audited without the URL.
- `GET /api/v1/connectors` lists the tenant's connectors with a `configured` flag, never a value. It is not rate limited.
- `POST /api/v1/connectors/bitrix24 { webhookUrl }`:
  - checks the shape (`parseWebhookUrl`: https, `/rest/<user>/<code>/`, no credentials or query);
  - asks the portal for its CRM mode with the connector's own allow-listed client (`validateConfiguration`, no redirects);
  - only then stores the URL encrypted, creates or activates the `bitrix24` tenant connector with `webhookSecretRef: store:bitrix24_webhook_url`, and sets the mock connector's `createLead` to false.
  - Refusals: `INVALID_WEBHOOK_URL`, `LEADS_DISABLED` (simple CRM, mode 2), `CRM_REJECTED`, `CRM_UNREACHABLE` and `SECRETS_NOT_CONFIGURED`.
- `POST /api/v1/connectors/:id/disable` and `DELETE /api/v1/connectors/:id`. The delete removes the secret; the row stays.
- Connect, disable and disconnect together are limited to 10 calls a minute per operator.

**4. Web:** page `/crm`, "CRM integration".
- **Bitrix24 card:** the steps; the address as a password field; "Connect and check"; then Replace address, Disable and Disconnect.
- **Other cards:** the Internal CRM card (always active: leads stay in tezda), and amoCRM and HubSpot as coming soon.
- Strings are in en, ru and uz-Latn. The layout and a11y gates cover the page.

**5. e2e seam:** `BITRIX24_TEST_BASE_URL` (refused in production) sends the check to a local fake portal. The hardened HTTP client blocks IP literals, so the request goes to a fixed `.invalid` name that only this transport resolves to the loopback address.

## Consequences
- An owner or admin can connect Bitrix24 without server access. The URL is never in a response, a log line, an audit row or the page.
- Lead routing still uses the DEF-015 stopgap: the oldest active connector that can create leads. Connecting Bitrix24 switches the mock connector's lead creation off. Disabling or disconnecting Bitrix24 does not switch it back on, so the tenant has no external lead sink until it reconnects; leads stay in tezda either way.
- `.env` deployments that used `env:CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL` keep working. A web connect rewrites that row's reference to `store:`.
- **Not done:** phone lookup and deal stage for the agent (later slice, own ADR); amoCRM; HubSpot; a "test connection" button for an already connected portal; a real Bitrix24 portal call (only fakes in tests).

## Alternatives considered
- **Reusing `channel_secrets`:** rejected by the owner (decision 2). Its foreign key and associated data belong to channel accounts.
- **Storing the URL in `tenant_connectors.config`:** rejected. Config is validated, readable data; a secret belongs in the encrypted store.
