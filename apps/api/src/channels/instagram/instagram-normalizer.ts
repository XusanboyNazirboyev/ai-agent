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

export type InstagramIgnoreReason =
  'echo' | 'self_test' | 'deleted' | 'no_text' | 'not_a_message';

export type NormalizedInstagramEvent =
  | NormalizedInstagramText
  | { readonly kind: 'ignored'; readonly reason: InstagramIgnoreReason };

export type InstagramNormalization =
  | { readonly ok: true; readonly events: readonly NormalizedInstagramEvent[] }
  | { readonly ok: false; readonly reason: 'invalid' | 'wrong_object' };

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
        if (!message) {
          events.push({ kind: 'ignored', reason: 'not_a_message' });
        } else if (message.is_echo) {
          // Our own outgoing message echoed back: never answer ourselves.
          events.push({ kind: 'ignored', reason: 'echo' });
        } else if (message.is_self) {
          events.push({ kind: 'ignored', reason: 'self_test' });
        } else if (message.is_deleted) {
          events.push({ kind: 'ignored', reason: 'deleted' });
        } else if (!message.text || message.text.trim() === '') {
          events.push({ kind: 'ignored', reason: 'no_text' });
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
  return { ok: true, events };
}
