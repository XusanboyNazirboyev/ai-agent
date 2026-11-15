# ADR 070: Quick replies a workspace writes (roadmap P1.8, first slice)

Status: accepted 2026-11-15 (roadmap order; no owner question open).

## Context
P1.8 bundles teams and queues, assignment rules, presence, server-side read state, conversation tags and a canned-response library. It is split into slices; this one is the library. Until now the composer offered five fixed replies from the UI catalog.

## Decision
- `canned_responses` (tenant, title up to 80 characters, text up to 2000, position); additive migration `20261125150000_canned_responses`. At most 200 per workspace (a guard); creates take a per-workspace advisory lock so the cap and positions hold under parallel requests.
- API `api/v1/canned-responses`: every signed-in role lists; OWNER and ADMIN add, change (title, text, position) and delete. Tenant from the session only. Each write is audited with the title only, never the text.
- Web: Settings, Channels, "Quick replies" (read-only for operators and viewers), with add, edit, move up or down, delete with confirmation. The composer offers the workspace's replies; while it has none, the five built-in ones stay.
- The assistant never sends these; an operator inserts one into the reply box and can still change it before sending.
- Not in this slice: placeholders (customer name), per-operator replies, shortcuts like "/price", replies per language. Next P1.8 slices: conversation tags, server-side read state, assignment rules and presence.

## Verified
- Integration (`canned-responses.integration.spec.ts`, real Postgres): roles, ordering, audit without text, bad bodies, other tenant 404, cap under a race of 5 parallel creates. Mutation: without the lock all 5 creates pass the cap; the test fails.
- Web unit: built-in fallback and own replies (`lib/canned.test.ts`), settings groups.
- e2e: `quick-replies.spec.ts` (admin writes at 390 px without overflow, operator inserts it), `operator-flow`, `settings-groups`, a11y and layout specs.
