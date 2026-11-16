# ADR 071: Tags on conversations (roadmap P1.8, second slice)

Status: accepted 2026-11-16 (roadmap order; no owner question open).

## Decision
- `conversation_tags` (tenant, conversation, tag), the same tag dictionary as people and leads (ADR 053); additive migration `20261126090000_conversation_tags`. The migration also adds the ADR 050 tenant-isolation policies to `conversation_tags`, `lead_tasks` and `canned_responses` (ENABLE, not FORCE: no effect while the app connects as the owner).
- `PUT /api/v1/inbox/conversations/:id/tags` replaces a chat's tag set (OWNER, ADMIN, OPERATOR; tenant from the session; a chat of an erased contact is not found). Audited as `conversation.tags_set` with counts only. Archiving a tag removes it from chats too; the tag list reports `usage.conversations`.
- The inbox list returns `tags` per row (one query per page, no N+1) and accepts `tagId` as a filter in every scope, including the SQL-built waiting queue. The conversation view returns `conversation.tags`.
- Web: "Chat tags" editor at the top of the conversation details, the first two tags (then "+N") on each list row, and a Tag filter next to language and score.
- Not in this slice: tag-based assignment rules, automatic tags from the assistant.

## Verified
- Integration (`conversation-tags.integration.spec.ts`): set, list chips, filter in `all` and `waiting`, view, remove, archive cascade, audit; viewer 403, foreign tag 400, other tenant 404, erased contact 404. Mutation: disabling the waiting-queue filter fails the test. Existing tag suites (41) and inbox suites pass.
- e2e `conversation-tags.spec.ts` plus operator-flow, tags, lead, layout and a11y specs (98 passed; one a11y lead-card keyboard test failed once in the batch and passed 2/2 alone, recorded as flaky).
