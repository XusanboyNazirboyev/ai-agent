'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NAV, type NavKey } from './nav';
import type { FeedItem } from './notification-feed';

/**
 * Owner 2026-11-25: after a release people should see what changed, in the
 * bell and as a mark on the place that changed. Written by us with each
 * release (newest first); the text is `whatsNew.<id>` in every locale.
 */
export interface AppUpdate {
  id: string;
  /** Release day, YYYY-MM-DD. */
  date: string;
  /** The page that changed; opening it (or the notification) clears the mark. */
  href: string;
}

export const APP_UPDATES: readonly AppUpdate[] = [
  { id: 'documentImport', date: '2026-11-25', href: '/agent/knowledge' },
  { id: 'knowledgeGaps', date: '2026-11-24', href: '/agent/knowledge' },
  { id: 'botSchedule', date: '2026-11-24', href: '/agent/rules' },
  { id: 'storyReplies', date: '2026-11-24', href: '/inbox' },
  { id: 'ownerPause', date: '2026-11-24', href: '/inbox' },
];

/** An update is news for this many days after its release. */
export const FRESH_DAYS = 14;

export function freshUpdates(
  now: Date,
  updates: readonly AppUpdate[] = APP_UPDATES,
): AppUpdate[] {
  const since = now.getTime() - FRESH_DAYS * 24 * 60 * 60 * 1000;
  return updates.filter(
    (update) => new Date(`${update.date}T00:00:00Z`).getTime() >= since,
  );
}

/** The top-level menu item a path belongs to (same rule as the lit item). */
export function navKeyOf(path: string): NavKey | undefined {
  return NAV.find(
    (item) =>
      path.startsWith(`/${item.key}`) ||
      (item.alsoUnder ?? []).some((under) => path.startsWith(under)),
  )?.key;
}

/** Only a list of known ids survives a reload (storage is untrusted). */
export function parseSeen(raw: string | null): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value)
      ? value.filter(
          (id): id is string =>
            typeof id === 'string' &&
            APP_UPDATES.some((update) => update.id === id),
        )
      : [];
  } catch {
    return [];
  }
}

/** A set of update ids kept per operator in this browser; undefined until read. */
function useStoredIds(
  key: string | null,
): [string[] | undefined, (ids: string[]) => void] {
  const [ids, setIds] = useState<string[] | undefined>();
  useEffect(() => {
    if (!key) return;
    try {
      setIds(parseSeen(window.localStorage.getItem(key)));
    } catch {
      setIds([]);
    }
  }, [key]);
  const add = useCallback(
    (more: string[]) =>
      setIds((current) => {
        if (!current) return current;
        const next = [...new Set([...current, ...more])];
        if (next.length === current.length) return current;
        try {
          if (key) window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Not persisted (private mode); it still applies to this tab.
        }
        return next;
      }),
    [key],
  );
  return [ids, add];
}

/** Fresh updates for one operator in this browser, as bell items and menu marks. */
export function useAppUpdates(
  operatorId: string | undefined,
  pathname: string,
): {
  items: FeedItem[];
  freshNav: NavKey[];
  /** Pages with a release note not opened yet (exact `href`s). */
  freshPaths: string[];
  markSeen: (id: string) => void;
  markAllSeen: () => void;
  /** The bell's trash: seen and no longer listed. */
  clearAll: () => void;
} {
  // undefined until storage is read, so nothing flashes as new on load.
  const [seen, addSeen] = useStoredIds(
    operatorId ? `ac_updates_seen_${operatorId}` : null,
  );
  const [cleared, addCleared] = useStoredIds(
    operatorId ? `ac_updates_cleared_${operatorId}` : null,
  );
  const fresh = useMemo(() => freshUpdates(new Date()), []);
  const loaded = seen !== undefined;
  // Opening the place that changed is reading the news.
  useEffect(() => {
    if (!loaded) return;
    addSeen(
      fresh
        .filter((update) => pathname.startsWith(update.href))
        .map((update) => update.id),
    );
  }, [addSeen, fresh, pathname, loaded]);
  const unseen = seen
    ? fresh.filter((update) => !seen.includes(update.id))
    : [];
  const allIds = useCallback(() => fresh.map((update) => update.id), [fresh]);
  return {
    items:
      seen && cleared
        ? fresh
            .filter((update) => !cleared.includes(update.id))
            .map((update) => ({
              id: `update:${update.id}`,
              type: 'app.update',
              at: `${update.date}T00:00:00.000Z`,
              conversationId: null,
              title: null,
              updateId: update.id,
              read: seen.includes(update.id),
            }))
        : [],
    freshNav: [
      ...new Set(
        unseen
          .map((update) => navKeyOf(update.href))
          .filter((navKey): navKey is NavKey => navKey !== undefined),
      ),
    ],
    freshPaths: [...new Set(unseen.map((update) => update.href))],
    markSeen: useCallback((id: string) => addSeen([id]), [addSeen]),
    markAllSeen: useCallback(() => addSeen(allIds()), [addSeen, allIds]),
    clearAll: useCallback(() => {
      addSeen(allIds());
      addCleared(allIds());
    }, [addSeen, addCleared, allIds]),
  };
}
