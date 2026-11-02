# Plan: knowledge from the videos on the connected Instagram account

Design and open questions: [ADR 033](../adr/033-knowledge-from-company-videos.md) (Proposed). Code starts only after Phase 7.3 is closed (owner, 2026-11-02). Each slice is one branch, merged only after its acceptance passes.

## Slice 0: verify and measure (scripts and evidence only)
- **Blocked by:** V2, V3, V4, V11.
- **API check:** read-only calls on the agreed account (with explicit approval for live Instagram calls). They confirm:
  - the media list path and fields under Instagram Login (`caption` especially);
  - whether `media_url` is present for the account's reels;
  - the `ig_post` and reel attachment fields in a DM;
  - whether `ig_post_media_id` matches the media id.
- **Provider measurement:** each candidate runs on the account's videos. Measured for each video and candidate:
  - key-fact recall and precision against a reference list a person writes;
  - invented facts;
  - transcript quality judged by a native speaker (uz-Latn, uz-Cyrl, ru);
  - cost and time per minute.
- **Output:** a report in `docs/evidence/` with raw counts, without customer data, tokens or keys.
- **Done when:** the owner picks the provider (V1), and every unverified API point is confirmed or the design is changed.

## Slice 1: sync and drafts (backend)
- **Blocked by:** V1, V5, V6, V7, V8, V9.
- **Migration:** `channel_media` and `knowledge_drafts`, additive. It needs the owner's approval like every migration.
  - Fields: `tenantId`, channel, media id, permalink, type, timestamps, status, segments, flagged spans and linked catalog items.
- **Sync job:** per active Instagram channel (BullMQ, scheduled, plus "sync now").
  - Lists media since the last sync and queues new or changed videos.
  - Switches off the knowledge of posts no longer listed.
- **Media job:**
  1. Downloads the video, or falls back to the caption and the thumbnail.
  2. Calls the provider, metered with purpose `media`.
  3. Scans for money, percentage and date spans, then stores the draft.
  4. Deletes the file.
- **Approval** (per V7): an approved draft creates or updates a knowledge document (source kind `instagram_video`) and indexes it.
- **Tests:**
  - unit: segment mapping, scanner, sync diff;
  - integration: tenant isolation, a draft is never retrieved before approval, a removed post is switched off, the file is deleted, an unpriced model is refused;
  - fakes for the provider and for the Graph API: no live calls in CI.

## Slice 2: web
- **Knowledge page:** an "Instagram videos" list with thumbnail, status and last sync.
  - The draft view shows `MM:SS` segments, flagged spans and suggested catalog links.
  - Approve and Reject; "sync now".
- **Strings:** en, ru and uz-Latn.
- **Gates:** layout and a11y.
- **e2e:** against the fakes.

## Slice 3: questions about a shared post (amends ADR 031)
- **Adapter change:** the Instagram adapter turns an `ig_post` attachment (and a reel attachment, if slice 0 confirms its fields) into a referenced media id instead of ignoring the message.
- **Retrieval:** passages from that video's document rank first, and its linked catalog items are the first lookup candidates.
- **A share with no text:** handled as decided in V10.
- **Tests:** webhook fixtures for each attachment type, plus the cases where the id is unknown and where the post is not approved.

## Slice 4: eval
- **Cases per pack and locale:**
  - a question about a product in a post;
  - the price of that product (from the tool, never the post);
  - a shared post that is not in the knowledge base;
  - a question the video does not answer (no invention; handover rules apply).
- **Done when:**
  - hard-fact accuracy stays 100%;
  - the language stays `beta` until the D18 review passes.

## Later: suggested knowledge from customer questions (own ADR)
- Frequent and unanswered questions are grouped into the same draft queue (source kind `conversation`).
- Each one is approved by an admin. Customer text is untrusted (D16).
