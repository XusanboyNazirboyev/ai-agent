import { z } from 'zod';

/**
 * Instagram messaging webhook -> channel-neutral events. Field names come from
 * the official "Webhook Notification Examples" page (read 2026-10-31):
 * `object`, `entry[].id` (our business account), `entry[].time`,
 * `messaging[].sender.id` (Instagram-scoped customer id), `recipient.id`,
 * `timestamp`, `message.mid`, `message.text`, `message.is_echo`.
 *
 * Unverified, so deliberately not relied on: the unit of `timestamp`, the
 * exact shape of attachments, and whether the body is an object or an array
 * (the docs template shows an array; both are accepted). The receive time is
 * assigned by us, so the messaging window never depends on Meta's clock.
 * Customer text is untrusted data and is only length-bounded here.
 *
 * Comments (ADR 043; "Webhook Notification Examples" and the fields matrix,
 * read 2026-11-07): `entry[].changes[]` with `field: "comments"` and a
 * `value` holding `comment_id` (Unified Login / Facebook Login; `id` in the
 * Instagram Login example), `from {id, username}`, `text`, `media {id,
 * media_product_type}` and `parent_id` when the comment answers a comment.
 * Each change is validated on its own: a malformed one is ignored.
 */
const id = z.string().min(1).max(100);

const messagingItem = z
  .object({
    sender: z.object({ id }).passthrough(),
    recipient: z.object({ id }).passthrough(),
    timestamp: z.number().nonnegative().optional(),
    message: z
      .object({
        mid: z.string().min(1).max(500),
        text: z.string().max(5_000).optional(),
        is_echo: z.boolean().optional(),
        is_self: z.boolean().optional(),
        is_deleted: z.boolean().optional(),
        is_unsupported: z.boolean().optional(),
        /**
         * Media sent with the message ("Webhook Notification Examples",
         * read 2026-11-10): `attachments[] { type, payload { url } }`, `audio`
         * among the supported types. Untrusted: the URL is only a candidate
         * to download (media-download.ts), never trusted.
         */
        attachments: z
          .array(
            z
              .object({
                type: z.string().max(50).optional(),
                payload: z
                  .object({ url: z.unknown().optional() })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          )
          .max(20)
          .optional(),
      })
      .passthrough()
      .optional(),
    /**
     * ADR 044: a carousel button tap, `postback { mid, title, payload }`
     * ("Webhook Notification Examples", read 2026-11-09). Untrusted.
     */
    postback: z
      .object({
        mid: z.string().min(1).max(500),
        title: z.string().max(1_000).optional(),
        payload: z.string().max(1_000),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const entry = z
  .object({
    id,
    time: z.number().nonnegative().optional(),
    messaging: z.array(messagingItem).max(100).optional(),
    changes: z
      .array(
        z
          .object({ field: z.string().max(100), value: z.unknown() })
          .passthrough(),
      )
      .max(100)
      .optional(),
  })
  .passthrough();

const commentValue = z
  .object({
    comment_id: id.optional(),
    id: id.optional(),
    text: z.string().max(5_000).optional(),
    parent_id: id.optional(),
    from: z
      .object({ id, username: z.string().max(100).optional() })
      .passthrough(),
    media: z
      .object({ id, media_product_type: z.string().max(50).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const body = z
  .object({ object: z.string(), entry: z.array(entry).max(100) })
  .passthrough();

const payload = z.union([body, z.array(body).max(100)]);

export type NormalizedInstagramText = {
  readonly kind: 'text';
  /** Idempotency key for the queue (D7). */
  readonly messageId: string;
  /** Our business account (`entry.id`). */
  readonly accountId: string;
  /** The customer, Instagram-scoped. */
  readonly customerId: string;
  readonly text: string;
  readonly receivedAt: Date;
};

/**
 * ADR 042: a voice message. The audio is not in the webhook, only the URL of
 * an `audio` attachment; the worker downloads and transcribes it before the
 * agent answers.
 */
export type NormalizedInstagramVoice = {
  readonly kind: 'voice';
  readonly messageId: string;
  readonly accountId: string;
  readonly customerId: string;
  readonly url: string;
  readonly receivedAt: Date;
};

/** Stored in `messages.media_ref` (VarChar 2048): longer URLs are ignored. */
export const MAX_MEDIA_URL_CHARS = 2_000;

/**
 * ADR 044: a carousel button tap. The payload is untrusted; Meta's button
 * `title` is not kept (the service rebuilds the text from what we sent).
 */
export type NormalizedInstagramPostback = {
  readonly kind: 'postback';
  readonly messageId: string;
  readonly accountId: string;
  readonly customerId: string;
  readonly payload: string;
  readonly receivedAt: Date;
};

/** ADR 043: a top-level comment on one of our posts. */
export type NormalizedInstagramComment = {
  readonly kind: 'comment';
  readonly commentId: string;
  /** Our business account (`entry.id`). */
  readonly accountId: string;
  /** The commenter, Instagram-scoped. */
  readonly fromId: string;
  readonly username: string | null;
  readonly text: string;
  readonly mediaId: string | null;
  readonly mediaProductType: string | null;
  readonly receivedAt: Date;
};

export type InstagramIgnoreReason =
  | 'echo'
  | 'self_test'
  | 'deleted'
  | 'no_text'
  | 'not_a_message'
  | 'own_comment'
  | 'comment_reply'
  | 'not_a_comment';

export type NormalizedInstagramEvent =
  | NormalizedInstagramText
  | NormalizedInstagramVoice
  | NormalizedInstagramComment
  | NormalizedInstagramPostback
  | { readonly kind: 'ignored'; readonly reason: InstagramIgnoreReason };

export type InstagramNormalization =
  | { readonly ok: true; readonly events: readonly NormalizedInstagramEvent[] }
  | { readonly ok: false; readonly reason: 'invalid' | 'wrong_object' };

/** The URL of the first `audio` attachment, when it is a plausible string. */
function audioUrlOf(
  attachments:
    | ReadonlyArray<{
        type?: string | undefined;
        payload?: { url?: unknown } | undefined;
      }>
    | undefined,
): string | undefined {
  for (const attachment of attachments ?? []) {
    if (attachment.type !== 'audio') continue;
    const url = attachment.payload?.url;
    if (
      typeof url === 'string' &&
      url.length > 0 &&
      url.length <= MAX_MEDIA_URL_CHARS
    )
      return url;
  }
  return undefined;
}

export function normalizeInstagramWebhook(
  raw: unknown,
  receivedAt: Date,
): InstagramNormalization {
  const parsed = payload.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const bodies = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  if (bodies.some((b) => b.object !== 'instagram'))
    return { ok: false, reason: 'wrong_object' };
  const events: NormalizedInstagramEvent[] = [];
  for (const b of bodies)
    for (const e of b.entry)
      for (const m of e.messaging ?? []) {
        const message = m.message;
        if (!message && m.postback) {
          events.push({
            kind: 'postback',
            messageId: m.postback.mid,
            accountId: e.id,
            customerId: m.sender.id,
            payload: m.postback.payload,
            receivedAt,
          });
        } else if (!message) {
          events.push({ kind: 'ignored', reason: 'not_a_message' });
        } else if (message.is_echo) {
          // Our own outgoing message echoed back: never answer ourselves.
          events.push({ kind: 'ignored', reason: 'echo' });
        } else if (message.is_self) {
          events.push({ kind: 'ignored', reason: 'self_test' });
        } else if (message.is_deleted) {
          events.push({ kind: 'ignored', reason: 'deleted' });
        } else if (!message.text || message.text.trim() === '') {
          const url = audioUrlOf(message.attachments);
          if (url)
            events.push({
              kind: 'voice',
              messageId: message.mid,
              accountId: e.id,
              customerId: m.sender.id,
              url,
              receivedAt,
            });
          else events.push({ kind: 'ignored', reason: 'no_text' });
        } else {
          events.push({
            kind: 'text',
            messageId: message.mid,
            accountId: e.id,
            customerId: m.sender.id,
            text: message.text,
            receivedAt,
          });
        }
      }
  for (const b of bodies)
    for (const e of b.entry)
      for (const change of e.changes ?? []) {
        if (change.field !== 'comments') {
          events.push({ kind: 'ignored', reason: 'not_a_comment' });
          continue;
        }
        const value = commentValue.safeParse(change.value);
        const commentId = value.success
          ? (value.data.comment_id ?? value.data.id)
          : undefined;
        if (!value.success || !commentId) {
          events.push({ kind: 'ignored', reason: 'not_a_comment' });
        } else if (value.data.from.id === e.id) {
          // Our own comment or reply: never answer ourselves.
          events.push({ kind: 'ignored', reason: 'own_comment' });
        } else if (value.data.parent_id) {
          // A reply inside a thread (possibly to our reply): no bot loops.
          events.push({ kind: 'ignored', reason: 'comment_reply' });
        } else if (!value.data.text || value.data.text.trim() === '') {
          events.push({ kind: 'ignored', reason: 'no_text' });
        } else {
          events.push({
            kind: 'comment',
            commentId,
            accountId: e.id,
            fromId: value.data.from.id,
            username: value.data.from.username ?? null,
            text: value.data.text,
            mediaId: value.data.media?.id ?? null,
            mediaProductType: value.data.media?.media_product_type ?? null,
            receivedAt,
          });
        }
      }
  return { ok: true, events };
}
