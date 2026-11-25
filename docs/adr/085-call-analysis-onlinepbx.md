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

## Step 2 done (2026-11-23): OnlinePBX client, connect, poller

- `telephony/onlinepbx-client.ts`: `auth.json`, `mongo_history/search.json` with `end_stamp_from/to` and `user_talk_time_from=1` (answered calls only; window at most a week), and the recording link (`uuid` + `download=1`), accepted only under `https://api2.onlinepbx.ru/calls-records/download/` (the documented host; unverified on a real account). `isNotAuth` re-authenticates once. Errors carry a code (`UNREACHABLE`, `REJECTED`, `BAD_RESPONSE`), never the key or the provider's text.
- `GET/POST/DELETE /api/v1/telephony[/onlinepbx]` (OWNER/ADMIN, 10 changes a minute, audited without the key): connect checks the key with `auth.json` first and needs call minutes on the plan (`PLAN_REQUIRED`); disconnect deletes the sealed key (migration `20261201100000`) and keeps the calls. Reading starts at connect time; a new domain or a re-enable does not import the calls made meanwhile.
- **Poller is a `ScheduledScan`, not a BullMQ repeatable job:** the API already runs its periodic work through one interval with an overlap guard (`HandoverRuntime`); the scan runs every 5 minutes, reads from the cursor minus 2 minutes, catches up a week per run after an outage, and is idempotent by `(tenant, account, provider call id)`. Customer phone: the destination of an `outbound` call, the caller otherwise. Calls are counted oldest first against the month (tenant time zone, PENDING and ANALYSED, minutes rounded up per call); one that does not fit is `SKIPPED_LIMIT`. The OnlinePBX session is kept in memory per account.
- Not yet: downloading and storing the audio, transcription, summary (step 3); contact matching; UI (step 4); a real OnlinePBX account (C1).

## Step 3a done (2026-11-25): transcript, summary, contact

- `telephony/call-analysis.scan.ts` (`CallAnalysisScan`, a `ScheduledScan`): claims PENDING calls oldest first by bumping `attempts` from the value it read (two processes cannot both claim), at most two in flight per process (OvozAI's limit), and runs them without blocking the other scans. A claimed call is left alone for 15 minutes (lease); after three attempts it is `FAILED` with the last code (`DOWNLOAD_*`, `STT_*`, `LLM_*`, OnlinePBX codes).
- Per call: recording link from OnlinePBX (session shared with the poller through `OnlinePbxSessions`), download through `downloadPublicMedia` (SSRF guard, 100 MB, 2 minutes), OvozAI `verbose_json` segments (`ovozai-call-transcriber.ts`, 8-minute timeout, 429/502/503 as `BUSY`), one structured LLM call with purpose `call_summary` through `AgentConversationService.tenantStructured` (tenant monthly budget and ledger, no conversation), then `ANALYSED` with `transcript`, `summary`, `nextStep` and the contact matched by the last nine phone digits (`PHONE_KEY_SQL`).
- Speakers (C2 not done, so no Gladia): the summary model returns one letter per numbered segment (`S` staff, `C` customer) for at most 200 segments; a count that does not match labels nothing (`speaker: null`). The transcript in the prompt is capped at 30 000 bytes (under `LLM_MAX_INPUT_BYTES`).
- The summary is written in the tenant's default locale; the transcript is untrusted data in the user message, the instructions say not to follow it and not to add facts.
- Without `OVOZAI_API_KEY` the scan does nothing and calls stay PENDING.
- Not yet: the audio is not stored (step 3b: S3 SSE-KMS, 30-day lifecycle); OvozAI cost is not recorded on the ledger (the plan's minutes bound it; OvozAI's credit price is not in the pricing catalog); the `verbose_json` segment shape is the OpenAI form, parsed leniently and unverified on a real call; UI (step 4); a real OnlinePBX account (C1).
