# ADR 043: Replying to Instagram comments

- **Status:** Accepted (owner decisions 2026-11-07); parts 1–3 and the public reply implemented; the operator Comments list is planned; not enabled until the live check (step 5).
- **Owner decisions (2026-11-07):** reply only to comments that ask something or show interest (price, information, enrolment); praise, emoji, spam, abuse and competitor comments get no bot reply (operators see them). A reply is a short public reply under the comment without facts, plus one private message (DM) to the commenter that carries the actual answer.

## Facts from Meta docs (read 2026-11-07)
- Webhooks fields matrix: with Unified Login the `comments` field needs `instagram_manage_comments` (https://developers.facebook.com/documentation/instagram-platform/webhooks/fields.md).
- Payload (webhooks/examples.md): `object: "instagram"`, `entry[].id` = our account, `changes[].field = "comments"`, `value.comment_id`, `value.from {id, username}`, `value.text`, `value.media {id, media_product_type}`, `value.parent_id` for a reply in a thread.
- Public reply: `POST graph.facebook.com/{ig-comment-id}/replies?message=…`; top-level comments only; not hidden comments, not live video (reference/ig-comment/replies.md).
- Private reply: one message to the commenter within 7 days, `recipient: { comment_id }` (business-messaging/instagram-messaging/features/private-replies.md, shown with a Page token). The conversation continues inside the 24-hour window only after the customer answers.
- **Not documented:** whether the Unified Login system-user token can call `/replies` and send a private reply on `graph.facebook.com/<IG_ID>/messages` with `recipient.comment_id`. Both are verified live on staging before the feature is enabled for any tenant; until then a failure is recorded, never retried blindly.
- Standard Access: only people with a role on the app; real customers need Advanced Access (App Review).

## Design
1. **Part 1 (done):** the normalizer recognises top-level comments; own comments, thread replies, empty and malformed changes are ignored per change. The controller counts comments as ignored.
2. **Part 2 – storage and intake:** table `instagram_comments` (tenant, channel account, comment id unique per account, media id, commenter id and username, untrusted text, status `RECEIVED | SKIPPED | ANSWERED | NEEDS_OPERATOR | FAILED`, category, public reply id, private reply message id, conversation id, error code). Intake dedupes on the comment id and writes an outbox event `instagram.comment` (hashed idempotency key, ADR 031 lesson on id length).
3. **Part 3 – decision and DM:** the worker runs only for an ACTIVE account in LIVE mode (SHADOW records the decision without sending). The commenter gets a DM conversation keyed by their Instagram-scoped id; the comment text enters it as an inbound message of type `COMMENT` and the normal agent turn (metering, facts guardrail, locale) decides. Comments whose extracted intent is not interest (`search`, `details`, `price`, `availability`, `booking_interest`, `capabilities`) are marked SKIPPED with no send. The agent's reply to a `COMMENT` message is sent as a private reply (`recipient.comment_id`, 7-day window) instead of a normal DM.
4. **Part 4 – public reply and UI:** after the private reply succeeds, a short locale template ("Rahmat! Batafsil ma'lumotni sizga xabar qilib yubordik.") is posted under the comment; no facts, no prices. The inbox shows the comment source; a Comments list shows skipped comments for operators.
5. Enable comments in `subscribeUnified` (`messages,comments`) only after the live check.

## As implemented (2026-11-07)
- Intake (`InstagramWebhookService.acceptComment`): dedupe on `(tenant, account, comment_id)`; ids must be digits (else ignored, not 503); the comment is an inbound `COMMENT` message; `lastInboundAt` is not touched, so no DM is allowed until the customer writes.
- Core (`runAgentTurn`, `origin: 'public_comment'`, set when every message of the answered batch is a comment): opt-out words, proposal confirmations and business actions do not apply; an unclear language, a model failure, a budget stop or an intent outside the reply set ends with outcome `NO_REPLY` (empty reply, earlier slots kept). Intents answered: search, details, price, availability, booking_interest, capabilities, regulated_info. Handovers after a reply-set intent (e.g. STUCK, tool failure) still send their notice privately.
- Commit step: `NO_REPLY` creates no outbound message, no lead rescoring and no language/slot change; the comment row becomes `SKIPPED` (or `FAILED`, `agent_unavailable`, after a model or budget stop, so operators see it). A bot reply to a batch made only of comments is bound at commit to the latest comment as its private reply (`privateReplyMessageId`); a batch that includes a direct message is answered by direct message and the comment stays `RECEIVED`.
- Send (`InstagramCommentReplyService`): a bound bot reply, or an operator reply when the customer's latest message is an unanswered comment, is sent as the one private reply. More than one Instagram message, a comment older than 7 days, a non-Unified account or a definite API refusal fail with a code, the row becomes `FAILED` and the reservation is released (an operator can still answer). Ambiguous outcomes stay UNKNOWN and are never resent.
- Known trade-off (review 2026-11-07): like a direct message, a comment reopens a CLOSED conversation (otherwise the bot could not answer it), also when the comment is then skipped.
- Public reply: outbox event `instagram.comment_reply` after the private reply is SENT; the locale template `commentPublicReply` (the private reply's turn locale, else the tenant default); skipped for live video; posted at most once (an ambiguous outcome is recorded, never retried).
- `from.id` of a comment is used as the conversation key. Whether it equals the IGSID of the same person's DMs is not stated in the pages read: if not, a later DM opens a second conversation (harmless, checked in the live test).

## Risks
- Public replies are visible to everyone: templates only, never model text.
- Loops: our own comments and thread replies are ignored at the normalizer.
- Volume: a viral post can bring hundreds of comments; the queue processes them at the per-account rate lock; classification costs one FAST call each.
