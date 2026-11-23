# ADR 085: Call analysis for OnlinePBX recordings

- **Status:** Accepted (owner decisions 2026-11-23). Not implemented.
- **Context:** the owner wants the tenant's phone calls analysed ("call analizni ham qo'shish kerak") and asked whether the new `GLADIA_API_KEY` or the other speech keys can do it. This is not ADR 045 (the AI answering calls itself); here people talk on the tenant's own PBX and we read the recordings afterwards.

## Owner decisions (2026-11-23)

1. **Source:** the tenant's IP telephony; first OnlinePBX.
2. **Output per call:** a short summary and the agreed next step, shown on the lead (no operator scoring, no sentiment in this version).
3. **Audio:** kept 30 days, encrypted, then deleted; the transcript and the analysis stay.
4. **Plans:** Premium only, 300 analysed minutes a month.

## Measurements (2026-11-23, project keys, synthetic call: two Uzbek speakers and one Russian, 21 s)

| Engine | Text | Speakers |
|---|---|---|
| OvozAI `verbose_json` | word for word, Uzbek Latin and Russian Cyrillic, timed segments | none |
| Gladia (Solaria-1, `diarization: true`) | Uzbek wrong: with `[uz, ru]` it chose Russian and wrote Uzbek in Cyrillic nonsense; with `[uz]` Cyrillic with errors and a missed phrase | correct: three speakers, correct boundaries |
| NeuronAI `/v1/stt/transcribe` | good, but Russian transliterated to Latin; one segment | none (not in its API) |

So the text comes from OvozAI and only the speaker turns from Gladia: each OvozAI segment takes the Gladia speaker whose utterances overlap it most in time. Gladia's own words are not used. Docs read 2026-11-23: https://docs.gladia.io/llms.txt (pre-recorded flow `POST /v2/upload` then `POST /v2/pre-recorded` with `diarization`, poll `result_url`; header `x-gladia-key`; Uzbek `uz` on Solaria-1), https://api.ovozai.uz/docs.md (`response_format=verbose_json` gives segments; 1 credit per second, 2 at a time; API audio deleted after processing, transcripts kept 7 days). Gladia's price and data policy (read 2026-11-23: https://www.gladia.io/pricing, https://docs.gladia.io/chapters/limits-and-specifications/data-retention.md): Solaria-1 async about 0.27 EUR per hour of audio; self-serve plans train on customer audio by default with an opt-out, Free accounts keep audio and transcripts for a year. So every Gladia job is deleted (`DELETE /v2/pre-recorded/{id}`) as soon as its speaker turns are read, and the account's training opt-out must be switched on before customer calls are sent.

## OnlinePBX (docs read 2026-11-23: https://api.onlinepbx.ru/api-scheme.yaml, v2.10.1)

- Base `https://api2.onlinepbx.ru/{domain}/…`; every tenant has its own domain (`example.onpbx.ru`).
- Auth: `POST /{domain}/auth.json` with the panel's API key (`auth_key`) returns `key_id` and `key`; later calls send `x-pbx-authentication: key_id:key`; the key lives three days after its last use; a reply `{isNotAuth: true}` means authenticate again; frequent re-auth breaks sessions, so the key is cached.
- Calls: `POST /{domain}/mongo_history/search.json` (form) with `end_stamp_from`/`end_stamp_to` (at most one week per request), returns `uuid`, caller and destination numbers, `start_stamp`, `end_stamp`, `duration`, `user_talk_time`, `accountcode` (inbound/outbound/…). A call can take up to a minute to appear.
- Recording: the same endpoint with `uuid` and `download=1` returns a temporary `https://api2.onlinepbx.ru/calls-records/download/…/rec.mp3` link.
- No webhook in the API spec, so we poll.

## Design

1. **Connection (tenant settings):** OnlinePBX domain and API key, stored like other connector secrets (encrypted, never returned or logged). Premium only.
2. **Poller (BullMQ repeatable job, per connected tenant, every 5 minutes):** reads calls that ended since its cursor (minus a 2-minute overlap for the API delay), keeps answered calls (`user_talk_time > 0`), idempotent by `(tenant, provider, uuid)`. A call whose minutes would pass the month's 300 is stored as `SKIPPED_LIMIT` and not downloaded.
3. **Download and store:** the recording link is fetched at once by the SSRF-guarded downloader (size cap), stored in S3 with SSE-KMS under `tenants/{tenantId}/calls/{id}`; a bucket lifecycle rule deletes it after 30 days, and the row records `audioDeleteAfter`.
4. **Transcribe:** OvozAI segments plus Gladia speaker turns, merged as above; the queue runs at most two OvozAI jobs at a time (its limit). On failure the call is `FAILED` with a reason and retried a bounded number of times.
5. **Analyse:** one Gemini structured call (paid key) on the speaker-labelled transcript: `summary` and `nextStep` in the tenant's language. Internal text for the team, marked as AI-made; it is never sent to a customer, so D5 does not apply, and customer speech stays untrusted input (no instructions followed from it).
6. **Lead link:** the customer's number (the non-internal side) is matched to the tenant's contact by normalised phone; a match puts the call on that lead; no match leaves it under "Calls" to attach by hand.
7. **UI:** lead card section "Calls" (date, direction, duration, summary, next step, transcript by speaker, audio player while the audio exists via a short-lived signed URL); settings page to connect OnlinePBX and see the month's minutes used.
8. **Metering:** analysed minutes per tenant per month against the plan limit `callAnalysisMinutes` (Premium 300, others 0); provider costs recorded like other speech usage.
9. **Data:** a new table `call_recordings` with `tenant_id`, RLS like every tenant table, retention of transcripts follows the tenant's existing data retention and erasure.

## Order

1. Schema, connection settings and plan limit (migration; backup before release).
2. OnlinePBX client and poller with a recorded-fixture test; S3 bucket with SSE-KMS and the 30-day lifecycle on staging (infrastructure step).
3. Transcription merge (OvozAI + Gladia) and the Gemini summary, with tests on the synthetic call above.
4. Lead card and settings UI, e2e.
5. Staging trial with a real OnlinePBX account (needs the owner's or a pilot tenant's OnlinePBX domain and API key).

## Open

- **C1:** a real OnlinePBX domain and API key to test against (blocks step 5; steps 1 to 4 use recorded fixtures).
- **C2:** the owner switches on Gladia's model-training opt-out in the Gladia dashboard (blocks sending customer calls to Gladia; until then speakers are labelled from the text by the summary model, with lower accuracy).

## Step 1 done (2026-11-23)

- Migration `20261201090000_call_analysis`: `telephony_accounts` (one per tenant and provider; the API key sealed in the row with the channel-secret cipher) and `call_recordings` (idempotent by tenant, account and provider call id), both with the four RLS policies.
- **Not a `tenant_connectors` row:** that table is read as a CRM everywhere (connector list, role selection, catalog sync `listActive`), so a PBX there would show up as a broken CRM. Telephony stays out of `core/**` and out of the CRM tables.
- **Calls belong to the contact, not the lead:** `contact_id` (nullable); the lead card shows the calls of its contact. Contact erasure deletes the contact's calls (transcript and summary are the contact's words); deleting stored audio joins that step when audio storage lands (step 3).
- Plan limit `callAnalysisMinutes` (console plan editor and API); unlike the other limits a missing value means none. Staging: set Premium to 300 in the console after the release.
- The connect endpoint and the sealed-key store come with the OnlinePBX client in step 2, since saving a key is only useful once it can be checked against `auth.json`.
