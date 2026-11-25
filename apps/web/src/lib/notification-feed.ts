'use client';
import { useCallback, useEffect, useState } from 'react';
import { APP_UPDATES } from './app-updates';
import type { LiveEvent } from './live-updates';

/**
 * Owner 2026-11-24: "notifications never arrive". Live events were only a
 * beep, a toast or a desktop notification that needs permission; now each one
 * that needs a person is kept in a bell list in the header.
 */
export interface FeedItem {
  id: string;
  type:
    | 'handover.created'
    | 'handover.sla_breached'
    | 'task.due'
    | 'subscription.bot_paused'
    | 'subscription.past_due'
    | 'subscription.expired'
    /** A release note from `app-updates.ts`; never stored in this feed. */
    | 'app.update';
  at: string;
  conversationId: string | null;
  /** task.due only: the task title the server sent. */
  title: string | null;
  /** app.update only: the `APP_UPDATES` id. */
  updateId?: string;
  read: boolean;
}

export const FEED_LIMIT = 50;
const KEPT: readonly FeedItem['type'][] = [
  'handover.created',
  'handover.sla_breached',
  'task.due',
  'subscription.bot_paused',
  'subscription.past_due',
  'subscription.expired',
];

/** The feed with the event on top, or unchanged for an event nobody acts on. */
export function addEvent(
  items: readonly FeedItem[],
  event: LiveEvent,
  now: Date,
): FeedItem[] {
  if (!(KEPT as readonly string[]).includes(event.type)) return [...items];
  const item: FeedItem = {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    type: event.type as FeedItem['type'],
    at: now.toISOString(),
    conversationId: event.conversationId,
    title: event.taskTitle ?? null,
    read: false,
  };
  return [item, ...items].slice(0, FEED_LIMIT);
}

/** Where a notification leads. */
export function feedHref(item: FeedItem): string {
  if (item.type === 'app.update')
    return (
      APP_UPDATES.find((update) => update.id === item.updateId)?.href ??
      '/today'
    );
  if (item.type === 'task.due') return '/tasks';
  if (item.type.startsWith('subscription.')) return '/billing';
  return item.conversationId
    ? `/inbox?c=${encodeURIComponent(item.conversationId)}`
    : '/inbox';
}

/** Only well-formed stored items survive a reload (storage is untrusted). */
export function parseFeed(raw: string | null): FeedItem[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is FeedItem =>
          typeof item === 'object' &&
          item !== null &&
          typeof item.id === 'string' &&
          (KEPT as readonly string[]).includes(item.type) &&
          typeof item.at === 'string' &&
          typeof item.read === 'boolean',
      )
      .slice(0, FEED_LIMIT);
  } catch {
    return [];
  }
}

/** The bell's list for one operator in this browser. */
export function useNotificationFeed(operatorId: string | undefined): {
  items: FeedItem[];
  add: (event: LiveEvent) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
} {
  const key = operatorId ? `ac_notifications_${operatorId}` : null;
  const [items, setItems] = useState<FeedItem[]>([]);
  useEffect(() => {
    if (!key) return;
    try {
      setItems(parseFeed(window.localStorage.getItem(key)));
    } catch {
      setItems([]);
    }
  }, [key]);
  const save = useCallback(
    (update: (current: FeedItem[]) => FeedItem[]) =>
      setItems((current) => {
        const next = update(current);
        try {
          if (key) window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Not persisted (private mode); the list still works for this tab.
        }
        return next;
      }),
    [key],
  );
  return {
    items,
    add: useCallback(
      (event: LiveEvent) =>
        save((current) => addEvent(current, event, new Date())),
      [save],
    ),
    markRead: useCallback(
      (id: string) =>
        save((current) =>
          current.map((item) =>
            item.id === id ? { ...item, read: true } : item,
          ),
        ),
      [save],
    ),
    markAllRead: useCallback(
      () => save((current) => current.map((item) => ({ ...item, read: true }))),
      [save],
    ),
    clear: useCallback(() => save(() => []), [save]),
  };
}
