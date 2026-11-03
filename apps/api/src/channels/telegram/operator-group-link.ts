import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * One-click operator group (ADR 036 amendment): the web page opens
 * `t.me/<bot>?startgroup=<code>`; Telegram adds the bot to the chosen group
 * and sends `/start <code>` there; the webhook links that group.
 *
 * The code is stateless and signed: the channel account id, an expiry and an
 * HMAC (key derived from SECRETS_MASTER_KEY) over both plus the account's
 * current operator group. Linking changes that group, so a code works once;
 * it also stops working after GROUP_LINK_TTL_SECONDS. 36 bytes, 48 base64url
 * characters (Telegram allows 64).
 */
export const GROUP_LINK_TTL_SECONDS = 600;

const MAC_BYTES = 16;
const CODE = /^[A-Za-z0-9_-]{48}$/;
const START = /^\/start(?:@[A-Za-z0-9_]{1,64})?\s+([A-Za-z0-9_-]{1,64})\s*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A key used only for these codes, derived from the secrets master key. */
export function groupLinkKey(masterKeyBase64: string): Buffer {
  const master = Buffer.from(masterKeyBase64.trim(), 'base64');
  if (master.length !== 32)
    throw new Error('SECRETS_MASTER_KEY must be 32 bytes, base64 encoded');
  return Buffer.from(
    hkdfSync(
      'sha256',
      master,
      Buffer.alloc(0),
      'tezda/operator-group-link/v1',
      32,
    ),
  );
}

function mac(
  key: Buffer,
  accountId: string,
  expires: number,
  currentChatId: string | null,
): Buffer {
  return createHmac('sha256', key)
    .update(
      `v1\0${accountId.toLowerCase()}\0${expires}\0${currentChatId ?? ''}`,
    )
    .digest()
    .subarray(0, MAC_BYTES);
}

export function createGroupLinkCode(
  key: Buffer,
  accountId: string,
  currentChatId: string | null,
  now: Date,
): { code: string; expiresAt: Date } {
  if (!UUID.test(accountId)) throw new Error('accountId must be a UUID');
  const expires = Math.floor(now.getTime() / 1000) + GROUP_LINK_TTL_SECONDS;
  const expiry = Buffer.alloc(4);
  expiry.writeUInt32BE(expires);
  const code = Buffer.concat([
    Buffer.from(accountId.replaceAll('-', ''), 'hex'),
    expiry,
    mac(key, accountId, expires, currentChatId),
  ]).toString('base64url');
  return { code, expiresAt: new Date(expires * 1000) };
}

/**
 * True when `code` was made for `accountId` while its operator group was
 * `currentChatId`, and has not expired.
 */
export function verifyGroupLinkCode(
  key: Buffer,
  code: string,
  accountId: string,
  currentChatId: string | null,
  now: Date,
): boolean {
  if (!CODE.test(code) || !UUID.test(accountId)) return false;
  const bytes = Buffer.from(code, 'base64url');
  if (bytes.length !== 16 + 4 + MAC_BYTES) return false;
  const codeAccount = bytes.subarray(0, 16).toString('hex');
  if (codeAccount !== accountId.replaceAll('-', '').toLowerCase()) return false;
  const expires = bytes.readUInt32BE(16);
  if (expires * 1000 <= now.getTime()) return false;
  return timingSafeEqual(
    bytes.subarray(20),
    mac(key, accountId, expires, currentChatId),
  );
}

/** The payload of `/start <payload>` or `/start@bot <payload>`, if any. */
export function startPayload(text: string): string | undefined {
  return START.exec(text.trim())?.[1];
}
