import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shared by every Meta channel (Instagram, Messenger). Meta signs every webhook
 * POST with `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the payload
 * keyed with the app secret (Messenger webhooks page, read 2026-11-06). The
 * page says Meta signs an escaped-unicode form of the payload, so a decoded
 * string re-encoded by us gives another digest: the check must run on the RAW
 * bytes as received, before any JSON parsing, and in constant time.
 */
const PREFIX = 'sha256=';

export function verifyMetaSignature(input: {
  readonly rawBody: Buffer | string;
  readonly header: string | undefined;
  readonly appSecret: string;
}): boolean {
  const { header, appSecret } = input;
  if (!appSecret || !header || !header.startsWith(PREFIX)) return false;
  const given = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac('sha256', appSecret)
    .update(input.rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

/** Test helper: the header a genuine Meta delivery would carry. */
export function signMetaBody(
  rawBody: Buffer | string,
  appSecret: string,
): string {
  return `${PREFIX}${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * GET handshake when the webhook is registered: `hub.mode=subscribe`,
 * `hub.verify_token`, `hub.challenge`; echo the challenge only for our token.
 */
export function answerMetaHandshake(input: {
  readonly mode: string | undefined;
  readonly verifyToken: string | undefined;
  readonly challenge: string | undefined;
  readonly expectedToken: string;
}): string | undefined {
  if (input.mode !== 'subscribe') return undefined;
  if (!input.expectedToken || !input.verifyToken || !input.challenge)
    return undefined;
  const a = Buffer.from(input.verifyToken);
  const b = Buffer.from(input.expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return input.challenge;
}
