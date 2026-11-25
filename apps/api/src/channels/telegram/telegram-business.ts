import { z } from 'zod';
import {
  createGroupLinkCode,
  groupLinkKey,
  startPayload,
  verifyGroupLinkCode,
} from './operator-group-link.js';

/**
 * ADR 092: Telegram Business through the platform bot. Field names from
 * https://core.telegram.org/bots/api (Update, BusinessConnection,
 * BusinessBotRights, Message; read 2026-11-25).
 */

/** `external_account_id` of an owner's business account: `business:<telegram user id>`. */
export const BUSINESS_ACCOUNT_PREFIX = 'business:';
/** Deep-link payload prefix: `/start biz<code>` (A-Z a-z 0-9 _ - only). */
const LINK_PREFIX = 'biz';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function businessAccountKey(telegramUserId: string): string {
  return `${BUSINESS_ACCOUNT_PREFIX}${telegramUserId}`;
}

export function isBusinessAccountKey(externalAccountId: string): boolean {
  return externalAccountId.startsWith(BUSINESS_ACCOUNT_PREFIX);
}

/** The owner's Telegram user id of a business account key, if it is one. */
export function businessOwnerId(externalAccountId: string): string | undefined {
  return isBusinessAccountKey(externalAccountId)
    ? externalAccountId.slice(BUSINESS_ACCOUNT_PREFIX.length)
    : undefined;
}

export function businessLinkKey(masterKeyBase64: string): Buffer {
  return groupLinkKey(masterKeyBase64, 'tezda/telegram-business-link/v1');
}

/** A 10-minute signed `/start` payload naming the tenant (ADR 036 scheme). */
export function createBusinessLinkPayload(
  key: Buffer,
  tenantId: string,
  now: Date,
): { payload: string; expiresAt: Date } {
  const { code, expiresAt } = createGroupLinkCode(key, tenantId, null, now);
  return { payload: `${LINK_PREFIX}${code}`, expiresAt };
}

/** The tenant a `/start biz<code>` message was made for, or null. */
export function tenantFromStart(
  key: Buffer,
  text: string,
  now: Date,
): string | null {
  const payload = startPayload(text);
  if (!payload?.startsWith(LINK_PREFIX)) return null;
  const code = payload.slice(LINK_PREFIX.length);
  const bytes = Buffer.from(code, 'base64url');
  if (bytes.length < 16) return null;
  const hex = bytes.subarray(0, 16).toString('hex');
  const tenantId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID.test(tenantId) &&
    verifyGroupLinkCode(key, code, tenantId, null, now)
    ? tenantId
    : null;
}

const telegramId = z.union([
  z.number().int().safe().transform(String),
  z.string().regex(/^-?\d{1,20}$/u),
]);

const connectionSchema = z
  .object({
    id: z.string().min(1).max(200),
    user: z
      .object({ id: telegramId, language_code: z.string().max(20).optional() })
      .passthrough(),
    is_enabled: z.boolean(),
    rights: z
      .object({ can_reply: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const businessMessageSchema = z
  .object({
    message_id: z.number().int().positive().safe(),
    business_connection_id: z.string().min(1).max(200),
    from: z.object({ id: telegramId }).passthrough().optional(),
    sender_business_bot: z.object({}).passthrough().optional(),
    is_from_offline: z.boolean().optional(),
    chat: z.object({ id: telegramId }).passthrough(),
  })
  .passthrough();

export type BusinessUpdate =
  | {
      kind: 'connection';
      connectionId: string;
      ownerId: string;
      languageCode: string | undefined;
      /** Enabled and allowed to reply. */
      active: boolean;
    }
  | {
      kind: 'message';
      connectionId: string;
      fromId: string | undefined;
      /** Sent by a bot or by an away/greeting message, not typed by a person. */
      automatic: boolean;
      chatId: string;
      messageId: string;
      text: string;
      /** The raw Message, for the ordinary Telegram normalizer. */
      message: Record<string, unknown>;
    }
  /** Edited or deleted business messages: acknowledged, not processed. */
  | { kind: 'ignored' };

/** The business part of a platform-bot update, or null when it has none. */
export function readBusinessUpdate(body: unknown): BusinessUpdate | null {
  if (!body || typeof body !== 'object') return null;
  const update = body as Record<string, unknown>;
  if ('business_connection' in update) {
    const parsed = connectionSchema.safeParse(update.business_connection);
    if (!parsed.success) return { kind: 'ignored' };
    return {
      kind: 'connection',
      connectionId: parsed.data.id,
      ownerId: parsed.data.user.id,
      languageCode: parsed.data.user.language_code,
      active: parsed.data.is_enabled && parsed.data.rights?.can_reply === true,
    };
  }
  if ('business_message' in update) {
    const parsed = businessMessageSchema.safeParse(update.business_message);
    if (!parsed.success) return { kind: 'ignored' };
    const message = parsed.data;
    return {
      kind: 'message',
      connectionId: message.business_connection_id,
      fromId: message.from?.id,
      automatic:
        message.sender_business_bot !== undefined ||
        message.is_from_offline === true,
      chatId: message.chat.id,
      messageId: String(message.message_id),
      text: typeof message.text === 'string' ? message.text : '',
      message: update.business_message as Record<string, unknown>,
    };
  }
  if (
    'edited_business_message' in update ||
    'deleted_business_messages' in update
  )
    return { kind: 'ignored' };
  return null;
}

/** Update types the platform bot's webhook asks for (ADR 080 + ADR 092). */
export const PLATFORM_ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const;
