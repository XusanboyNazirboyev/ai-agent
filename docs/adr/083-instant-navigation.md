# ADR 083 — Instant page switches (loading boundaries and a short client cache)

Status: accepted (2026-11-19). Owner report: "pagelarga o'tishda qotib qolyabdi" — switching pages freezes.

## Cause (measured 2026-11-19)
- Staging server is healthy: t4g.small, CPU credits full (576), load 0.0, 1.1 GB memory available. Server render of a page is fast.
- From the owner's network one round trip to the server (eu-central-1) is about 0.2 s; a fresh connection with TLS costs 0.5–0.7 s and single answers spiked to 2–4 s.
- Every page is rendered per request because the root layout reads the request headers for the CSP nonce (ADR 021). Next.js does not prefetch a dynamic route unless it has a `loading.js` boundary, and the app had none. A click therefore left the old page on screen, with no sign of progress, until the server answered (Next.js 16 docs, `01-getting-started/04-linking-and-navigating.md` "Dynamic routes without loading.tsx"; `02-guides/prefetching.md`, read 2026-11-19 from the installed `next@16.4.6`).
- Reproduced in e2e by holding navigation answers back 3 s: the address stayed on the old page.

## Decision
- `loading.tsx` (a shared `PageLoading` skeleton with a `role="status"` label) at `(app)`, `(app)/leads`, `(app)/contacts`, `(app)/settings`, `(app)/settings/bot` and `console/(admin)`, so every in-app link (menu, lead cards, settings sections, console tabs) is prefetched up to its boundary and a click switches at once.
- `experimental.staleTimes.dynamic = 30`: a page visited in the last 30 s is shown again without a server request. Safe because pages fetch their data in the browser (TanStack Query); only the page's server part is reused.
- The CSP nonce stays; static pages without a nonce were not chosen (weaker policy).

## Not done
- Moving the server closer to the users (region change) — infrastructure and cost decision for the owner.
- Next.js Cache Components / partial prefetching — larger migration.

## Verified
`e2e/navigation-feedback.spec.ts` (menu click and opening a lead with a 3 s server delay: address changes and the skeleton shows within 1 s) failed before the change and passes after it.


## Amendment — lead navigation request waterfalls (2026-11-20)

Measured before changing code, against `c677793` in a secrets-free copy of the
worktree: production Next.js build, Chromium, local PostgreSQL/Redis and seeded
fictional tenants, OWNER session, desktop viewport, `/today` → `/leads` → a lead.
Every GET received 250 ms of added browser-route delay (excluding SSE). Network
request/finished events were captured; no staging account or real provider was used.

`/leads` requests: team, tags and pipelines in parallel; then
`/api/v1/pipelines/:pipelineId/board`; then seven parallel
`/api/v1/leads?pipelineId=…&stageId=…&limit=25` requests. These dependencies supply
the pipeline/stage IDs; no duplicate request within that navigation was observed.
No board implementation change is included.

Lead-page timings below are relative to the first API request for that navigation:

| Request | Before start–finish (ms) | After start–finish (ms) |
| --- | --- | --- |
| `/api/v1/leads/:id` | 0–263 | 4–321 |
| `/api/v1/custom-fields?entity=LEAD` | 302–560 | 0–318 |
| `/api/v1/canned-responses` | 303–562 | 1–315 |
| `/api/v1/inbox/conversations/:id` | 304–582 | 4–334 |
| `/api/v1/pipelines/:pipelineId/board` | 304–570 | reused from cache |

Lead-page API span: **582 → 334 ms**; GET count: **5 → 4**. The board request was
a duplicate of the unfiltered board fetched just before navigation. Team data was
already fresh in the shared cache. `/leads` API span was 859 → 936 ms (11 GETs in
both samples); this path was not optimized. These are individual controlled
samples, not staging timings or a claim about total click-to-render latency.

Decision: use the matching cached board/list lead as TanStack `placeholderData`.
It mounts the card/chat immediately and starts their requests alongside the
mandatory fresh lead read; it does not seed the authoritative detail cache or skip
its read. A failed read replaces the placeholder with the error screen. Uncached
links retain their loading state. Share the existing unfiltered board query key
(`NO_FILTERS`), never a filtered board; normal freshness/invalidation still applies.
No wider cache lifetime, API contract, tenant boundary or UI text changes.

Verification: five regression tests cover parallel start, one request per shared
lookup, fresh detail replacement, no placeholder from another lead, error removal,
unfiltered board reuse and filtered-board separation. Three tests fail against the
old implementation; all pass after. Web tsc, 494 unit tests and format pass; API
build and five Playwright checks (navigation feedback, lead-page UX and the temporary
network measurement harness) pass. Tests ran in the secrets-free source copy because
the normal e2e setup reads the root `.env` automatically.

Owner-reported staging observations remain unverified here: about 170 MB of swap,
and about 4 s for the first request after idle. No server tuning or release performed.
