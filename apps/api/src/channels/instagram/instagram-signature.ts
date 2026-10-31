import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every webhook POST with `X-Hub-Signature-256: sha256=<hex>`,
 * the HMAC-SHA256 of the RAW request body keyed with the app secret
 * (docs/research/channel-rules.md, Instagram webhook auth). The check must run
 * on the exact bytes received, before any JSON parsing, and must be
 * constant-time so the signature cannot be guessed byte by byte.
 */
const PREFIX = 'sha256=';

export function verifyInstagramSignature(input: {
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
export function signInstagramBody(
  rawBody: Buffer | string,
  appSecret: string,
): string {
  return `${PREFIX}${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * GET handshake when the webhook is registered: Meta sends
 * `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`; the endpoint
 * must echo the challenge only when the token is the one we configured.
 */
export function answerInstagramHandshake(input: {
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
