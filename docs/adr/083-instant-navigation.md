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

## Amendment — lazy locales and a 5-minute page cache (2026-11-24)

Owner report: switching pages is slow. Measured from outside (not from the owner's network) against staging `fed084d`: every page and API answer in about 0.28 s, of which about 0.18 s is the TLS connection; the server is not the bottleneck. The largest browser chunk (415 KB, 118 KB gzip) held all three translation catalogs, so every visit downloaded and parsed two languages it never showed.

- Only English (the fallback for every key) stays in the main bundle; Russian and Uzbek are separate chunks loaded when chosen (`src/i18n/catalogs.ts`, `loadCatalog`). The provider switches language only once its messages are loaded, so no key flashes. Built chunks: English 43 KB gzip, Uzbek 34 KB, Russian 41 KB: an Uzbek user loads 77 KB instead of 118 KB.
- `staleTimes.dynamic` 30 → 300 s: a page seen in the last 5 minutes reopens without a server round trip. Safe for the same reason as before: data is fetched in the browser; only the near-static page shell is reused.

Not measured: click-to-content time from the owner's network (needs the browser on their side); server memory and swap (the AWS session had expired).
- **Prefetch from the menu (2026-11-24, owner chose it over moving the server):** menu links prefetch their page in full (`prefetch` on the Link; the 5-minute page cache keeps it), and pointing at or focusing a menu item starts that page's first reads (`src/lib/page-prefetch.ts`) with the exact query options the page uses (`src/lib/queries.ts`, shared so the keys cannot drift); a hover within 30 s of the last answer fetches nothing. Covered by a unit test (keys filled, no second fetch) and an e2e test (after a hover the Inbox list opens within 1.5 s although its API answer is then held 3 s; it fails when the prefetch reads another list). Server checked the same day (AWS session renewed): 1 GB of 1.8 GB free, 180 MB swap idle (no swap in or out), load 0.2 on 2 cores: not the bottleneck; the remaining cost is the round trip to eu-central-1.

## Amendment — intent-only menu prefetch (2026-11-24)

Owner report: pages still feel slow and heavy. The production build contains
2,034,551 raw bytes of client JavaScript chunks. More importantly, the desktop
rail exposed six destinations to operators and seven to managers with full Link
prefetch forced on every visible item. That makes a browser warm pages the person
did not ask for while the current page is still becoming interactive.

Decision: menu Links use `prefetch={false}` and warm exactly one route with
`router.prefetch()` on pointer hover, keyboard focus or touch start. The same
intent still starts that page's first TanStack reads through `PAGE_PREFETCH`.
Before: six or seven eager route-prefetch candidates on desktop page load. After:
zero before intent and one after intent. Loading boundaries remain the click-time
fallback, and the 5-minute route cache is unchanged.

The component regression test proves that every rail link disables automatic
prefetch, no route is warmed during render, and pointing at Inbox warms `/inbox`
once. A browser network trace still needs the local Playwright flow; no staging or
server setting was changed.
