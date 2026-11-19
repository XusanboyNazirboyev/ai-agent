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
