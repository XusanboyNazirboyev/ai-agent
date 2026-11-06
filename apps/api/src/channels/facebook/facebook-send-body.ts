import { splitMetaText } from '../meta/meta-text.js';

/** Page-scoped ids and Page ids are numeric strings. */
export const FACEBOOK_ID = /^[0-9]{1,100}$/u;

export type FacebookSendRequest = {
  readonly recipient: { readonly id: string };
  readonly messaging_type: 'RESPONSE';
  readonly message: { readonly text: string };
};

/**
 * `POST /<PAGE_ID>/messages` bodies for a reply, one per text part (Send API
 * page, read 2026-11-06). `RESPONSE` is the only messaging type used: a reply
 * inside the 24-hour window. Throws on an invalid recipient so a malformed id
 * can never reach the network.
 */
export function buildFacebookTextRequests(
  recipientId: string,
  text: string,
): FacebookSendRequest[] {
  if (!FACEBOOK_ID.test(recipientId)) throw new RangeError('Invalid recipient');
  return splitMetaText(text).map((part) => ({
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message: { text: part },
  }));
}
