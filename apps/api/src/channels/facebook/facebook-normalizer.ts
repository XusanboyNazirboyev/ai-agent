import { z } from 'zod';

/**
 * Messenger (Facebook Page) webhook -> channel-neutral events. Names come from
 * the official messages event page (read 2026-11-06): `object: "page"`,
 * `entry[].id` (the Page), `entry[].time`, `messaging[].sender.id` (a
 * Page-scoped user id, PSID), `recipient.id` (the Page), `timestamp`,
 * `message.mid`, `message.text`; attachments, `quick_reply` and `reply_to` are
 * optional.
 *
 * Unverified, so deliberately not relied on: the unit of `timestamp`, the
 * maximum text length, and the `is_echo` field (the messages page does not
 * document it). Echoes are therefore also recognised by `sender.id` equal to
 * the Page. Only `entry[].messaging` is read: `standby` (another app owns the
 * thread) is never answered. The receive time is ours, so the 24-hour window
 * never depends on Meta's clock. Customer text is untrusted data.
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
        is_deleted: z.boolean().optional(),
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

export type NormalizedFacebookText = {
  readonly kind: 'text';
  /** Idempotency key for the queue (D7). */
  readonly messageId: string;
  /** Our Facebook Page (`entry.id`). */
  readonly accountId: string;
  /** The customer, Page-scoped (PSID). */
  readonly customerId: string;
  readonly text: string;
  readonly receivedAt: Date;
};

export type FacebookIgnoreReason =
  'echo' | 'deleted' | 'no_text' | 'not_a_message';

export type NormalizedFacebookEvent =
  | NormalizedFacebookText
  | { readonly kind: 'ignored'; readonly reason: FacebookIgnoreReason };

export type FacebookNormalization =
  | { readonly ok: true; readonly events: readonly NormalizedFacebookEvent[] }
  | { readonly ok: false; readonly reason: 'invalid' | 'wrong_object' };

export function normalizeFacebookWebhook(
  raw: unknown,
  receivedAt: Date,
): FacebookNormalization {
  const parsed = body.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  if (parsed.data.object !== 'page')
    return { ok: false, reason: 'wrong_object' };
  const events: NormalizedFacebookEvent[] = [];
  for (const e of parsed.data.entry)
    for (const m of e.messaging ?? []) {
      const message = m.message;
      if (!message) {
        // Postbacks, delivery and read receipts carry no `message`.
        events.push({ kind: 'ignored', reason: 'not_a_message' });
      } else if (message.is_echo || m.sender.id === e.id) {
        // Our own outgoing message echoed back: never answer ourselves.
        events.push({ kind: 'ignored', reason: 'echo' });
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
