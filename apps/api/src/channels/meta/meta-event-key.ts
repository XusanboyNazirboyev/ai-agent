import { createHash } from 'node:crypto';

/** provider_event_id and provider_message_id are VARCHAR(200). */
const COLUMN_MAX = 200;

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * A Meta message id (`mid`) as stored: unchanged when it fits the 200-character
 * columns, otherwise `sha256:<hex>` of it. Real Instagram mids are long
 * base64 strings and the normalizer accepts up to 500 characters; the mapping
 * is deterministic, so redelivery still finds the stored event.
 */
export function storedMetaId(mid: string): string {
  return mid.length <= COLUMN_MAX ? mid : `sha256:${sha256(mid)}`;
}

/**
 * The outbox idempotency key for an inbound Meta message: always built from a
 * hash, so the prefix and the account id never push it past 200 characters.
 */
export function metaInboundKey(
  channelType: string,
  channelAccountId: string,
  mid: string,
): string {
  return `${channelType}.inbound:${channelAccountId}:${sha256(mid)}`;
}
