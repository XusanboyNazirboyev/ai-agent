# Bitrix24 lead-sink connector: plan (not approved, no code)

- **Status:** approved by the owner on 2026-10-27 with the decisions below. It is implemented on branch `feat/bitrix24-lead-sink` (not merged; session 2 merges after the owner's review).
- **Owner decision (2026-10-27):** the EduFlow connector is cancelled for now; its plan stays as docs in `docs/connectors/eduflow/`. The first real connector is Bitrix24 cloud as a **lead sink**, through an inbound webhook. amoCRM comes later.
- **Time box:** about 3 hours to be CI-green, reviewed and demonstrated. Otherwise the submission goes without it, and the README lists it as deferred (that line is already on `docs/submission-readme`).

## Sources

All official Bitrix24 REST documentation, read 2026-10-27:

| Topic | URL |
|---|---|
| Create lead (deprecated) | https://apidocs.bitrix24.com/api-reference/crm/leads/crm-lead-add.html |
| Create CRM item (current) | https://apidocs.bitrix24.com/api-reference/crm/universal/crm-item-add.html |
| List CRM items | https://apidocs.bitrix24.com/api-reference/crm/universal/crm-item-list.html |
| Lead fields | https://apidocs.bitrix24.com/api-reference/crm/leads/crm-lead-fields.html |
| Duplicate search | https://apidocs.bitrix24.com/api-reference/crm/duplicates/crm-duplicate-find-by-comm.html |
| Timeline comment | https://apidocs.bitrix24.com/api-reference/crm/timeline/comments/crm-timeline-comment-add.html |
| CRM mode | https://apidocs.bitrix24.com/api-reference/crm/crm-settings-mode-get.html |
| Inbound webhooks | https://apidocs.bitrix24.com/local-integrations/local-webhooks.html |
| Limits | https://apidocs.bitrix24.com/limits.html |

**Unverified** marks anything the pages did not state. Each unverified item is checked once against the owner's test portal, and the result is recorded as a scrubbed fixture before it is relied on.

## What the docs say (relied on)

- **`crm.lead.add` is deprecated.** "Development of this method has been halted"; the docs recommend `crm.item.add`. The plan uses **`crm.item.add` with `entityTypeId: 1`** (lead), which takes camelCase fields and returns `result.item.id`.
- **Multi-fields.** On `crm.item.add`, phone and email go in the array `fm` as `{ typeId: "PHONE" | "EMAIL", valueType, value }`. The deprecated method used `PHONE: [{ VALUE, VALUE_TYPE }]`.
- **Lead fields used:**
  - `title`, `name`;
  - `sourceId` (a SOURCE directory value; defaults include `OTHER`, `WEB`, `CALLBACK`);
  - `sourceDescription`, `comments` (plain string);
  - `originatorId` and `originId` (strings, "used only for linking to an external source", not read-only).
- **Duplicate search.** `crm.duplicate.findbycomm` takes `type` (`PHONE`/`EMAIL`), `values` (at most 20) and an optional `entity_type` (`LEAD`/`CONTACT`/`COMPANY`). It returns **IDs only**, as `{ LEAD: [ids], CONTACT: [ids], … }`, with no names, phones or emails. Phone extensions are ignored.
- **Timeline comment.** `crm.timeline.comment.add` takes `fields: { ENTITY_ID, ENTITY_TYPE: "lead", COMMENT }` and returns the comment ID. An empty comment gives `INVALID_ARG_VALUE`. No length limit is stated.
- **CRM mode.** `crm.settings.mode.get` returns `1` (classic, with leads) or `2` (simple, without leads).
- **Inbound webhook.** The URL is `https://<portal>/rest/<user id>/<secret code>/<method>`, and the secret code grants access within the webhook's scopes, with its creator's permissions.
  - The docs say not to publish the URL, to use POST (a GET leaves the URL in history and logs), and to send over HTTPS.
  - All methods used here need the `crm` scope.
- **Limits** (non-enterprise cloud plans):
  - The request counter is a leaky bucket that drains 2 per second, with a threshold of 50. Above the threshold, the next request fails with HTTP 503 `QUERY_LIMIT_EXCEEDED`. Enterprise plans drain 5 per second with a threshold of 250.
  - Limits are counted **per portal and source IP**, shared by every app calling from that IP. The docs say to retry with increasing delay and not to run parallel request series.
  - Per-method execution time is counted per webhook over 10 minutes. Above the limit, a call fails with HTTP 429 `OPERATION_TIME_LIMIT`; calls to that method are suspended until `time.operating_reset_at`, taken from the last successful response, or the next bucket reset.

## Scope

1. **Create lead:** `crm.item.add` with `entityTypeId: 1`.
2. **Duplicate check by phone, in code,** before the create. The model never receives other contacts' data; its only possible view is `{ exists: boolean, internalId: string | null }`.
   - Today lead sync is code-driven (`LeadSyncService`), and no model tool calls the connector at all.
3. **Conversation summary** as a timeline comment on the lead.

**Capabilities:**

| Capability | Value |
|---|---|
| `createLead` | `true` |
| `sync`, `search`, `liveQuote`, `availability`, `updateLead`, `createBooking`, `webhooks` | `false` (methods absent, as the contract requires) |

## Method allow-list (code, not config)

```
crm.settings.mode.get        (read; configuration check)
crm.duplicate.findbycomm     (read; type PHONE only)
crm.item.add                 (write; entityTypeId 1 only)
crm.timeline.comment.add     (write; ENTITY_TYPE "lead" only)
crm.item.list                (read; idempotency lookup by originId, stage of matching leads)
crm.item.fields              (read; used by the contract probe only)
crm.timeline.comment.list    (read; ENTITY_TYPE "lead" only: the retry marker check)
```

- The single request function takes a method name from a `const` tuple.
- Anything else, including a different `entityTypeId` or `ENTITY_TYPE`, throws `BITRIX24_METHOD_NOT_ALLOWED` **before any I/O**.
- No `batch` calls: each nested call counts separately anyway, and a batch would bypass per-method checks.

## Transport and the secret

- **Variable name:** `CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL`.
  - The existing `env:` resolver only resolves `CONNECTOR_SECRET_*` names (`connectors/registry/secret-resolver.ts`).
  - The tenant connector row stores `secretRef: env:CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL`, never the URL itself.
  - The owner adds the variable to `.env`. It is never pasted into chat.
- **Validated before the first request:**
  - `https:` only;
  - no credentials or query in the URL;
  - path exactly `/rest/<digits>/<code>/`;
  - the host passes the existing SSRF protection and DNS pinning from `generic-rest`. The portal domain suffixes (`bitrix24.com`, `.eu`, `.de`, …) are **unverified**, so the plan does not hard-code a list.
- **Requests:** POST with a JSON body to `<base><method>.json`, with a bounded timeout (existing `resilience/timeout`).
- **The URL never appears** in a log, error message, metric, fixture, test name or the operations table.
  - Errors carry the method name, HTTP status and Bitrix24 `error` code only.
  - Transport errors are re-wrapped, because fetch and undici errors include the URL.
  - A test asserts that the secret's code segment never appears in any thrown error or log line.

## Field mapping (`LeadInput` → `crm.item.add`)

| `LeadInput` | Bitrix24 field | Note |
|---|---|---|
| `contact.name` | `name` | omitted if absent |
| `contact.phone` | `fm: [{ typeId: "PHONE", valueType: "MOBILE", value }]` | `MOBILE` is **unverified** as a value type (the docs example uses `WORK`); checked on the test portal, else `WORK`. Phone normalized to E.164 first |
| (none) | `fm` EMAIL | **not mapped:** `LeadInput.contact` has no email today. Adding one is a canonical-model change, out of scope |
| (constant) | `title` | e.g. "Telegram: <name or 'new inquiry'>", from config, ≤ 255 chars (limit **unverified**) |
| (config) | `sourceId` | default `OTHER`; an owner-chosen SOURCE value is validated once at configuration |
| (constant) | `sourceDescription` | "tezda (Telegram)" |
| `score`, `reasonCodes` | `comments` | short, e.g. "Score WARM; reasons: PRICE_ASKED, DATE_GIVEN" |
| `summary` | timeline comment | see scope 3; plain text, control characters stripped, capped at 4000 chars (own cap: the docs state none). Whether Bitrix renders markup in `COMMENT` is **unverified**, so `[`/`<` are escaped |
| idempotency key | `originatorId: "tezda"`, `originId: <key>` | links the lead to the operation record |

`slots` are not sent in v1, because sending them needs a per-tenant field map to `UF_*` fields. They go in the comment text instead.

## Duplicate check (in code)

1. Call `crm.duplicate.findbycomm` with `type: PHONE`, `values: [e164]`, and no `entity_type`, so leads, contacts and companies are all searched. If there is no phone, skip the check.
2. Result: `{ exists, internalId }`, where `internalId` is the first ID with its type, e.g. `"LEAD:123"` or `"CONTACT:45"`. That is all that leaves the connector. IDs are not personal data of other customers, and the docs say no names or numbers are returned.
3. **Owner decision needed:** what happens when a duplicate exists.
   - **Recommended:** an existing **lead** gets a timeline comment and no new lead, and `createLead` returns that lead's ID. An existing **contact or company** only: create the lead with `contactId` set.
   - **Alternative:** always create a new lead, and put "possible duplicate: LEAD:123" in `comments`.

## Idempotency (ADR 023 operation records, ADR 024 lifecycle, Phase 7.0a write path)

- Lead sync already writes one `connector_operations` row per lead, with a stable key (`LeadSyncService`, `operations/write-policy.ts`). The connector declares `writeIdempotency`:
  - **`lookup`**, if `originId` is filterable (checked with `crm.item.fields` and recorded). Then `findLeadByIdempotencyKey(key)` is `crm.item.list` with `entityTypeId: 1` and `filter: { originatorId: "tezda", originId: key }`, selecting only `id`. A failure means "could not determine", never "not found". Filtering by `originId` is **unverified**; the docs say to check with `crm.item.fields`.
  - **`none`** otherwise. An unclear outcome (timeout, 5xx after send) becomes `STOP_UNCERTAIN` and waits for a person, never a blind retry.
- **The comment is a second logical write.** It gets its own operation row with key `<lead key>:comment`, runs only after the lead ID is known, and is `none`-idempotent: an uncertain comment is not repeated.
- **503 `QUERY_LIMIT_EXCEEDED` on a write** is treated as **not executed**, because the docs say the request is blocked. That is an inference, and a recorded fixture backs the test. Every other failure after the request was sent counts as uncertain.

## Rate limits and backoff

- **Client-side pacing per portal:** at most 1 request per second. That is half the documented drain rate, because the bucket is shared per IP. Calls are serial, with no parallel series.
- **503 `QUERY_LIMIT_EXCEEDED`:** exponential backoff with jitter (1 s, 2 s, 4 s), at most 3 retries. The retries are safe because the request was blocked.
- **429 `OPERATION_TIME_LIMIT`:** suspend that method for that webhook until `time.operating_reset_at` from the last successful response (kept in memory), or 60 s if unknown. The lead-sync job is re-queued with that delay rather than sleeping in-process. The existing circuit breaker opens on repeated failures.
- **Auth and configuration errors** are final and surface as a connector configuration error (logged without the URL), never as a customer-facing reply:
  - `NO_AUTH_FOUND`, `INVALID_CREDENTIALS`, `insufficient_scope`, `ACCESS_DENIED`;
  - `ERROR_METHOD_NOT_FOUND`, `PORTAL_DELETED`.

## Simple CRM (leads disabled)

- `validateConfiguration()` calls `crm.settings.mode.get`.
- `2` gives a configuration error `BITRIX24_LEADS_DISABLED`. It is reported as a configuration error in the log (no URL), and `createLead` is never attempted.
- **No fallback to deals** without owner approval. Deals are `entityTypeId: 2`, which the allow-list blocks.

## Where catalog facts come from

- This connector provides **no** catalog, offers, prices, seats or availability.
- **For the demo,** the tenant keeps the existing mock catalog connector (e.g. `mock-education`) for `sync` and `search`, and adds `bitrix24` as a second tenant connector for leads only. Offer facts and the display gate are unchanged.
- **Blocker found in code:**
  - `LeadSyncService.connectorFor` takes the **oldest active** connector with `createLead`;
  - the mock connector advertises `createLead: true`;
  - stored capabilities must match exactly (`assertStoredCapabilities`).

  So with both rows, leads would go to the mock connector.
- **Proposed fix, connector-level and not core:** a mock connector config flag `createLead: false` that removes the method and the capability. Alternative (core change, needs an ADR note): an explicit `leadSink` choice per tenant.
- **For a real tenant,** facts later come from a catalog source: the existing GenericRest connector pointed at the tenant's own catalog system, or another catalog connector. Bitrix24 product rows are out of scope.

## Tests (CI uses recorded, scrubbed fixtures only; no network)

- **Fixtures:**
  - recorded once from the owner's test portal, with fake data;
  - the portal host, user ID, secret code, IDs and any names or phones replaced (`portal.example.test`, `/rest/1/REDACTED/`);
  - a fixture-lint test fails CI if a fixture contains `/rest/<digits>/<non-REDACTED>/` or a real-looking phone.
- **Conformance:** `describeConnectorConformance` for `bitrix24` against the local fixture server (`testing/local-http.ts`):
  - every capability declared as a boolean, every advertised capability implemented;
  - unadvertised capabilities fail explicitly;
  - the `writeIdempotency` contract.
- **Unit tests:**
  - **allow-list:** a non-listed method, `entityTypeId` other than 1, or `ENTITY_TYPE` other than `lead` throws with zero requests made;
  - **URL validation:** http, a query string, a wrong path or a private address are refused;
  - **secret hygiene:** the code segment is absent from every error, log and operation row;
  - **mapping:** `fm` format; E.164 normalization; title, source, comments; the summary escape and cap;
  - **duplicate check:** none / lead / contact; only `{ exists, internalId }` returned; no-phone skip;
  - **idempotency:** a replayed key does no second create (lookup), uncertain gives `STOP_UNCERTAIN` (none), the comment key is separate;
  - **backoff:** 503 sequence then success; 503 exhausted; 429 with and without `operating_reset_at`; pacing ≤ 1 per second (fake timers);
  - **simple CRM:** mode `2` gives `BITRIX24_LEADS_DISABLED` and no write.
- **Integration (existing harness):** `LeadSyncService` with the Bitrix24 connector on the fixture server writes one operation row per lead, and a re-run makes no duplicate.

## Demo (owner's free test portal, fake data)

1. Owner: create an inbound webhook with the `crm` scope on the test portal, and put its URL in `.env` as `CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL`.
2. A configuration check reports the CRM mode and missing scopes, without printing the URL.
3. A simulated conversation (mock catalog, mock LLM or scripted) reaches a lead. Lead sync creates the Bitrix24 lead with the timeline comment. Re-running shows no duplicate, and a second conversation with the same phone takes the duplicate path.

## Size and order (time box ~3 h)

| Step | Work | Estimate |
|---|---|---|
| 1 | Allow-listed client, URL validation, pacing and backoff, error mapping, plus tests | 60 min |
| 2 | Mapping, duplicate check, create plus comment, `validateConfiguration`, plus tests | 50 min |
| 3 | Registration, mock `createLead: false` flag, conformance, fixtures plus lint | 40 min |
| 4 | Record fixtures on the test portal, demo, review | 30 min |

If step 4 cannot run (no portal yet), the connector is not claimed as demonstrated.

## Owner decisions (2026-10-27, approved)

1. **Duplicate:** an existing lead gets the conversation summary as a timeline comment, and its fields are never overwritten. Refined after the merger's review (2026-10-28): only a lead still in progress (`stageSemanticId` P) qualifies; a converted (S) or junk (F) lead does not, and a new lead is created. A contact match creates a new lead linked to the contact (`contactId`).
2. **Lead routing:** the mock connector has a config flag `createLead: false`. See follow-up 1.
3. **Lead source:** `sourceId` is `OTHER`, and "Telegram" appears in the title ("Telegram: <name>") and the comment text.
4. **Slots** go in the comment text for v1. Custom-field (`UF_*`) mapping comes later.

## Contract probe (2026-10-27, owner's test portal, synthetic data)

- **Script:** `apps/api/scripts/bitrix24-probe.ts`, using only allow-listed methods.
- **Requests:** 9, plus one read for the no-match shape. They created two `tezda-probe` leads and one comment.
- **Never printed or stored:** the webhook URL and the portal host.

| Unverified point | Result |
|---|---|
| Filter leads by `originatorId` + `originId` | **Works.** Exactly the created lead; an absent key returns 0 items. So `writeIdempotency` is **`lookup`** |
| `valueType: MOBILE` for a phone in `fm` | **Accepted**, stored as given |
| Lead title length | A 300-character title is **silently cut to 255**. The connector caps it at 255 itself |
| Markup in a timeline comment | Stored as given. Whether it **renders** needs a look in the portal UI (probe lead "Telegram: probe lead (synthetic)", comment 6). The connector replaces `[ ] < >` with look-alikes regardless |
| Portal domain suffix | `bitrix24.com` (no hard-coded suffix list; the URL shape and SSRF checks are enforced) |

- **Also recorded:**
  - the CRM mode is `1` (classic, with leads);
  - `crm.duplicate.findbycomm` returns IDs only (`{"LEAD":[2]}`), and **an empty list `[]` when nothing matches**;
  - `crm.item.add` echoes `fm` with an entry ID;
  - each response's `time` block carries `operating_reset_at`.

## Demo (2026-10-27)

`SIM_POSTGRES_DATABASE=agentcore_bitrix24_demo pnpm --filter @agentcore/api exec tsx scripts/bitrix24-demo.ts`:

1. A scripted customer asks for a person (scenario `edu-22`), going through the real v1 pipeline with a scripted model, so a lead is recorded.
2. The tenant keeps the mock catalog (`createLead: false`) and gets the `bitrix24` connector.
3. The real `LeadSyncService` creates Bitrix24 lead 6: "Telegram: Demo Synthetic A", source `OTHER`, `originId` = the operation key. The operation is `SUCCEEDED` in `lookup` mode.
4. A second sync returns `SKIPPED`, with no second lead.
5. A second conversation with the same synthetic phone takes the duplicate path: a comment on lead 6, and no new lead.

## Merger review fixes (2026-10-28)

| Finding | Fix | Test |
|---|---|---|
| Redirects could replay the POST past the allow-list | `maxRedirects: 0`; a redirect is `BITRIX24_REDIRECT_REFUSED` (not executed) | `bitrix24-transport.spec.ts` "refuses a 307 to another method and sends no second request" |
| A retried existing-lead write commented again | the key ends the comment (`tezda ref: <key>`); the latest comments are read first (`crm.timeline.comment.list`) | "a retried write on the existing-lead path adds exactly one comment" |
| The probe's output guard missed `./x` and `../x` | `isInsideDirectory`: resolve, then `path.relative` by segment | `src/dev/path-guards.spec.ts` |
| The demo picked the newest lead of any tenant | `runScenario` returns its tenant; `findDemoLead` is scoped by it | `testing/demo-lead.spec.ts` |
| a) the lookup trusted `items[0]` | the selected `originatorId`/`originId` must match exactly ([crm-item-list](https://apidocs.bitrix24.com/api-reference/crm/universal/crm-item-list.html) does not define plain-key matching) | "does not trust the first listed item" |
| b) string ids in duplicates were dropped | digit strings count ([crm-duplicate-find-by-comm](https://apidocs.bitrix24.com/api-reference/crm/duplicates/crm-duplicate-find-by-comm.html) documents integers) | "treats numeric-string ids … as a match" |
| c) a converted/junk lead absorbed inquiries | only `stageSemanticId` P ([object-fields](https://apidocs.bitrix24.com/api-reference/crm/universal/object-fields.html)) | "does not let a closed lead (stage S/F) absorb a new inquiry" |
| d) the 429 reset time was shared | per method ([limits](https://apidocs.bitrix24.com/limits.html): operating time per method) | "uses only the blocked method's own reset time after a 429" |
| e) a cut at 255 could split an emoji | count and cut by code point ([field-length-limits](https://apidocs.bitrix24.com/api-reference/crm/field-length-limits.html): limits in characters) | "never splits an emoji when it cuts at the length limit" |

What stays unverified is DEF-017.

## Known limitations

Tracked as DEF-012 to DEF-017 in `docs/DEFECTS.md` (DEF-012 fixed 2026-10-28).

- **Duplicate path and retries.** The summary is added to an existing lead without stamping our key on it. If that write's outcome were uncertain and retried, the lookup cannot find it, so a second identical comment is possible. A comment has low harm; lead fields are never changed.
- **A failed comment after the lead was created** is logged (code only), not retried. The lead exists, and repeating the create could only add comments.
- **No email:** `LeadInput.contact` has no email field.
- **Variable name.** The probe and demo scripts read `CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL` first and fall back to the older `BITRIX24_WEBHOOK_URL`. The API's connector config can only reference the `CONNECTOR_SECRET_` namespace, so the owner can rename the variable in `.env` without breaking the scripts.

## Follow-ups (not in this branch)

1. **A first-class lead-sink setting in the core:** separate roles for catalog source and lead sink, per tenant, instead of "the oldest active connector that can create leads". **Needs an ADR.** The mock `createLead: false` flag is the stopgap.
2. **A code-computed "derived price" fact:** quantity × a confirmed unit price, with provenance (both source facts, the quantity's origin, the rule). Group totals then no longer need the model to do arithmetic. Seen in the ladder evidence: "12 человек ≈ 14400 USD" was blocked as `UNSOURCED_NUMBER` (`docs/evidence/ladder-step1-1a.md`).
3. Custom-field (`UF_*`) mapping for slots; amoCRM (OAuth2 with rotating refresh tokens).

## Not in scope

amoCRM, deals, contacts or companies created directly, updates, bookings, inbound Bitrix24 events (outbound webhooks), product catalog, email (no canonical field), OAuth apps (inbound webhook only).
