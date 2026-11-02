# Plan: knowledge from company videos

Design and open questions: [ADR 033](../adr/033-knowledge-from-company-videos.md) (Proposed). Code starts only after Phase 7.3 is closed (owner, 2026-11-02). Each slice is one branch, merged only after its acceptance passes.

## Slice 0: measure before building (script and evidence only)
- **Blocked by:** V2, V3, V4.
- **What:** an offline script outside the product (no migration, no endpoint) runs each candidate on the sample videos.
- **Measured for each video and candidate:**
  - key-fact recall and precision against a reference list a person writes;
  - invented facts;
  - transcript quality judged by a native speaker (uz-Latn, uz-Cyrl, ru);
  - cost and time per minute of video.
- **Output:** a report in `docs/evidence/` with raw counts, without customer data or keys.
- **Done when:** the owner picks the provider (V1) from the report.

## Slice 1: backend
- **Blocked by:** V1, V5, V6.
- **Migration:** `knowledge_drafts`, additive. It needs the owner's approval like every migration.
  - Fields: `tenantId`, source kind, title, status, segments, flagged spans, linked catalog items, approver and times.
- **Upload endpoint:** OWNER and ADMIN only, CSRF, rate limited, audited.
  - Checks the type by content, not by name, and enforces the size and duration limits.
  - Streams the upload to temporary storage.
- **Job:** a BullMQ job calls the `MediaUnderstandingProvider`, meters the call (purpose `media`), stores the draft and deletes the file.
- **Scan:** the money, percentage and date scan marks spans.
- **Approve:** refused while money or percentage spans remain. Otherwise it creates a knowledge document (source kind `video`) and indexes it. **Reject** deletes the draft.
- **Tests:**
  - unit: segment mapping, scanner, refusal rules;
  - integration: tenant isolation, a draft is never retrieved before approval, the file is deleted, an unpriced model is refused;
  - a fake provider in tests: no live provider call in CI.

## Slice 2: web
- **Knowledge page:**
  - "Upload video", with progress and status;
  - a draft editor with `MM:SS` segments, flagged spans and catalog item links;
  - Approve and Reject.
- **Strings:** en, ru and uz-Latn.
- **Gates:** layout and a11y.
- **e2e:** against the fake provider.

## Slice 3: agent and eval
- **Eval cases per pack and locale:**
  - a question about a product seen in a video;
  - a price question about that product (the price comes from the tool, never the video);
  - a question the video does not answer (no invention; handover rules apply).
- **Done when:**
  - hard-fact accuracy stays 100%;
  - the language stays `beta` until the D18 review passes.

## Later: suggested knowledge from customer questions (own ADR)
- Frequent and unanswered questions are grouped into the same draft queue (source kind `conversation`).
- The answer is drafted from operator replies or existing sources.
- An admin approves each one (owner decision 2).
- Customer text is untrusted (D16), so nothing from a conversation is published without that approval.
