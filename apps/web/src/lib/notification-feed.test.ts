import { describe, expect, it } from 'vitest';
import type { LiveEvent } from './live-updates';
import {
  addEvent,
  FEED_LIMIT,
  feedHref,
  parseFeed,
  type FeedItem,
} from './notification-feed';

const now = new Date('2026-11-24T08:00:00Z');
const event = (
  type: LiveEvent['type'],
  extra: Partial<LiveEvent> = {},
): LiveEvent =>
  ({ type, conversationId: 'c1', handoverId: null, ...extra }) as LiveEvent;

describe('notification feed (owner 2026-11-24: notifications never arrive)', () => {
  it('keeps what needs a person, newest first, and skips routine updates', () => {
    let items: FeedItem[] = [];
    items = addEvent(items, event('handover.created'), now);
    items = addEvent(items, event('message.created'), now);
    items = addEvent(items, event('conversation.updated'), now);
    items = addEvent(items, event('task.due', { taskTitle: 'Call Ali' }), now);
    expect(items.map((i) => [i.type, i.title, i.read])).toEqual([
      ['task.due', 'Call Ali', false],
      ['handover.created', null, false],
    ]);
  });

  it('keeps at most fifty and leads each to its place', () => {
    let items: FeedItem[] = [];
    for (let i = 0; i < FEED_LIMIT + 5; i += 1)
      items = addEvent(items, event('handover.sla_breached'), now);
    expect(items).toHaveLength(FEED_LIMIT);
    expect(feedHref(items[0]!)).toBe('/inbox?c=c1');
    expect(feedHref(addEvent([], event('subscription.expired'), now)[0]!)).toBe(
      '/billing',
    );
    expect(feedHref(addEvent([], event('task.due'), now)[0]!)).toBe('/tasks');
  });

  it('reads back only well-formed stored items', () => {
    const good = addEvent([], event('handover.created'), now);
    expect(parseFeed(JSON.stringify(good))).toEqual(good);
    expect(parseFeed('not json')).toEqual([]);
    expect(
      parseFeed(JSON.stringify([{ id: 1 }, { ...good[0], type: 'x' }])),
    ).toEqual([]);
    expect(parseFeed(null)).toEqual([]);
  });
});
