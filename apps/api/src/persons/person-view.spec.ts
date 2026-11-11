/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest';
import {
  assemblePersonItem,
  type ContactActivity,
  type PersonContactRow,
} from './person-view.js';

const row = (id: string, at: string, extra: Partial<PersonContactRow> = {}) =>
  ({
    id,
    channelType: 'telegram',
    channelName: null,
    name: null,
    phone: null,
    language: null,
    consentStatus: 'UNKNOWN',
    marketingOptOut: false,
    createdAt: new Date(at),
    ...extra,
  }) as PersonContactRow;

describe('assemblePersonItem', () => {
  const person = {
    id: 'p',
    displayName: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('orders channels oldest first, takes the first non-null phone, aggregates', () => {
    const contacts = [
      row('b', '2026-02-01T00:00:00Z', {
        channelType: 'instagram',
        phone: '+2',
        marketingOptOut: true,
      }),
      row('a', '2026-01-01T00:00:00Z', { phone: null }),
      row('c', '2026-03-01T00:00:00Z', { phone: '+3' }),
    ];
    const activity = new Map<string, ContactActivity>([
      [
        'a',
        {
          conversationCount: 1,
          leadCount: 0,
          last: { id: 'ca', updatedAt: new Date('2026-04-01T00:00:00Z') },
        },
      ],
      [
        'b',
        {
          conversationCount: 2,
          leadCount: 3,
          last: { id: 'cb', updatedAt: new Date('2026-05-01T00:00:00Z') },
        },
      ],
    ]);
    const item = assemblePersonItem(person, contacts, activity);
    expect(item.channels.map((c) => c.contactId)).toEqual(['a', 'b', 'c']);
    expect(item.phone).toBe('+2');
    expect(item.conversationCount).toBe(3);
    expect(item.leadCount).toBe(3);
    expect(item.lastConversationId).toBe('cb');
    expect(item.lastActivityAt).toBe('2026-05-01T00:00:00.000Z');
    expect(item.marketingOptOut).toBe(true);
    expect(item.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('falls back to the oldest contact name when the person has none, and keeps the person name when set', () => {
    const contacts = [
      row('b', '2026-02-01T00:00:00Z', { name: 'Newer' }),
      row('a', '2026-01-01T00:00:00Z', { name: 'Older' }),
      row('c', '2026-03-01T00:00:00Z', { name: null }),
    ];
    expect(assemblePersonItem(person, contacts, new Map()).displayName).toBe(
      'Older',
    );
    expect(
      assemblePersonItem({ ...person, displayName: 'Own' }, contacts, new Map())
        .displayName,
    ).toBe('Own');
    expect(
      assemblePersonItem(person, [row('d', '2026-01-01T00:00:00Z')], new Map())
        .displayName,
    ).toBeNull();
  });

  it('returns nulls and zeros without activity', () => {
    const item = assemblePersonItem(
      person,
      [row('a', '2026-01-01T00:00:00Z')],
      new Map(),
    );
    expect(item).toMatchObject({
      phone: null,
      conversationCount: 0,
      leadCount: 0,
      lastConversationId: null,
      lastActivityAt: null,
      marketingOptOut: false,
    });
  });
});
