import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  businessAccountKey,
  businessLinkKey,
  businessOwnerId,
  createBusinessLinkPayload,
  readBusinessUpdate,
  tenantFromStart,
} from './telegram-business.js';
import { groupLinkKey, createGroupLinkCode } from './operator-group-link.js';

const master = randomBytes(32).toString('base64');
const key = businessLinkKey(master);
const tenantId = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const now = new Date('2026-11-25T10:00:00Z');

describe('Telegram Business link (ADR 092)', () => {
  it('a fresh /start biz payload names its tenant', () => {
    const { payload } = createBusinessLinkPayload(key, tenantId, now);
    expect(payload.length).toBeLessThanOrEqual(64);
    expect(tenantFromStart(key, `/start ${payload}`, now)).toBe(tenantId);
  });

  it('refuses an expired, altered or operator-group code', () => {
    const { payload } = createBusinessLinkPayload(key, tenantId, now);
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(tenantFromStart(key, `/start ${payload}`, later)).toBeNull();
    const last = payload.at(-1) === 'A' ? 'B' : 'A';
    expect(
      tenantFromStart(key, `/start ${payload.slice(0, -1)}${last}`, now),
    ).toBeNull();
    // Same scheme, other key: an operator-group code is not a business link.
    const group = createGroupLinkCode(
      groupLinkKey(master),
      tenantId,
      null,
      now,
    );
    expect(tenantFromStart(key, `/start biz${group.code}`, now)).toBeNull();
    expect(tenantFromStart(key, '/start hello', now)).toBeNull();
  });

  it('keys the account by the owner Telegram user id', () => {
    expect(businessOwnerId(businessAccountKey('42'))).toBe('42');
    expect(businessOwnerId('8123:bot')).toBeUndefined();
  });
});

describe('readBusinessUpdate', () => {
  it('reads a connection; active only when enabled and can_reply', () => {
    const connection = (
      rights: object | undefined,
      enabled = true,
    ): ReturnType<typeof readBusinessUpdate> =>
      readBusinessUpdate({
        update_id: 1,
        business_connection: {
          id: 'bc1',
          user: { id: 42, language_code: 'ru' },
          user_chat_id: 42,
          date: 1,
          is_enabled: enabled,
          ...(rights ? { rights } : {}),
        },
      });
    expect(connection({ can_reply: true })).toEqual({
      kind: 'connection',
      connectionId: 'bc1',
      ownerId: '42',
      languageCode: 'ru',
      active: true,
    });
    expect(connection({ can_reply: false })).toMatchObject({ active: false });
    expect(connection(undefined)).toMatchObject({ active: false });
    expect(connection({ can_reply: true }, false)).toMatchObject({
      active: false,
    });
  });

  it('marks bot-sent and away messages as automatic', () => {
    const message = (extra: object): ReturnType<typeof readBusinessUpdate> =>
      readBusinessUpdate({
        update_id: 2,
        business_message: {
          message_id: 7,
          business_connection_id: 'bc1',
          date: 1,
          chat: { id: 99, type: 'private' },
          from: { id: 42 },
          text: 'hi',
          ...extra,
        },
      });
    expect(message({})).toMatchObject({
      kind: 'message',
      connectionId: 'bc1',
      fromId: '42',
      chatId: '99',
      messageId: '7',
      automatic: false,
    });
    expect(message({ sender_business_bot: { id: 1 } })).toMatchObject({
      automatic: true,
    });
    expect(message({ is_from_offline: true })).toMatchObject({
      automatic: true,
    });
  });

  it('ignores edits and deletions, and leaves other updates to signup', () => {
    expect(
      readBusinessUpdate({ update_id: 3, edited_business_message: {} }),
    ).toEqual({ kind: 'ignored' });
    expect(
      readBusinessUpdate({ update_id: 4, deleted_business_messages: {} }),
    ).toEqual({ kind: 'ignored' });
    expect(readBusinessUpdate({ update_id: 5, message: {} })).toBeNull();
  });
});
