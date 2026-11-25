import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ru from '../i18n/ru.json';
import uz from '../i18n/uz-Latn.json';
import {
  APP_UPDATES,
  FRESH_DAYS,
  freshUpdates,
  navKeyOf,
  parseSeen,
  useAppUpdates,
} from './app-updates';

const SAMPLE = [
  { id: 'new', date: '2026-11-25', href: '/agent/rules' },
  { id: 'old', date: '2026-11-01', href: '/inbox' },
];

describe('release notes (owner 2026-11-25)', () => {
  it('keeps an update fresh for FRESH_DAYS days', () => {
    expect(FRESH_DAYS).toBe(14);
    const ids = (now: string): string[] =>
      freshUpdates(new Date(now), SAMPLE).map((u) => u.id);
    expect(ids('2026-11-26T10:00:00Z')).toEqual(['new']);
    expect(ids('2026-11-14T10:00:00Z')).toEqual(['new', 'old']);
    expect(ids('2026-12-10T10:00:00Z')).toEqual([]);
  });

  it('finds the menu item of a page, including pages kept under another item', () => {
    expect(navKeyOf('/agent/knowledge')).toBe('agent');
    expect(navKeyOf('/knowledge')).toBe('agent');
    expect(navKeyOf('/tasks')).toBe('crm');
    expect(navKeyOf('/nowhere')).toBeUndefined();
  });

  it('every update has text in all three languages and leads to a menu item', () => {
    for (const update of APP_UPDATES) {
      for (const catalog of [en, ru, uz] as Record<string, string>[])
        expect(catalog[`whatsNew.${update.id}`], update.id).toBeTruthy();
      expect(navKeyOf(update.href), update.href).toBeDefined();
    }
  });

  it('reads only known ids from storage', () => {
    const known = APP_UPDATES[0]!.id;
    expect(parseSeen(JSON.stringify([known, 'made-up', 7]))).toEqual([known]);
    expect(parseSeen('not json')).toEqual([]);
    expect(parseSeen(null)).toEqual([]);
  });
});

describe('useAppUpdates', () => {
  afterEach(() => window.localStorage.clear());
  const fresh = freshUpdates(new Date());
  // The list is dated; the hook test only runs while some note is fresh.
  const run = fresh.length > 0 ? it : it.skip;

  run('marks a fresh note until its page or the notification is opened', () => {
    const target = fresh[0]!;
    const { result, rerender } = renderHook(
      ({ path }) => useAppUpdates('op-1', path),
      { initialProps: { path: '/today' } },
    );
    expect(result.current.items.some((i) => !i.read)).toBe(true);
    expect(result.current.freshPaths).toContain(target.href);
    expect(result.current.freshNav).toContain(navKeyOf(target.href));

    rerender({ path: target.href });
    expect(result.current.freshPaths).not.toContain(target.href);
    expect(
      result.current.items.find((i) => i.updateId === target.id)?.read,
    ).toBe(true);
    expect(
      JSON.parse(window.localStorage.getItem('ac_updates_seen_op-1')!),
    ).toContain(target.id);

    act(() => result.current.markAllSeen());
    expect(result.current.freshNav).toEqual([]);
    expect(result.current.items.every((i) => i.read)).toBe(true);
  });

  run('the trash hides every note, also after a reload', () => {
    const first = renderHook(() => useAppUpdates('op-2', '/today'));
    expect(first.result.current.items.length).toBeGreaterThan(0);
    act(() => first.result.current.clearAll());
    expect(first.result.current.items).toEqual([]);
    expect(first.result.current.freshNav).toEqual([]);
    first.unmount();
    const again = renderHook(() => useAppUpdates('op-2', '/today'));
    expect(again.result.current.items).toEqual([]);
  });
});
