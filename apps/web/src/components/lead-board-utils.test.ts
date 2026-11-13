import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGE_DANGER_DAYS,
  AGE_WARN_DAYS,
  NO_FILTERS,
  ageDays,
  ageTone,
  filterParams,
  readCollapsed,
  writeCollapsed,
} from './lead-board-utils';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const daysAgo = (n: number): string =>
  new Date(NOW - n * 86_400_000 - 1000).toISOString();

describe('age chip', () => {
  it('counts whole days since the last activity', () => {
    expect(ageDays(daysAgo(0), NOW)).toBe(0);
    expect(ageDays(daysAgo(2), NOW)).toBe(2);
    expect(ageDays('not a date', NOW)).toBe(0);
    expect(ageDays(new Date(NOW + 5 * 86_400_000).toISOString(), NOW)).toBe(0);
  });

  it('is neutral under 3 days, warning at 3-6, danger from 7', () => {
    expect(AGE_WARN_DAYS).toBe(3);
    expect(AGE_DANGER_DAYS).toBe(7);
    expect(ageTone(0)).toBe('neutral');
    expect(ageTone(2)).toBe('neutral');
    expect(ageTone(3)).toBe('warning');
    expect(ageTone(6)).toBe('warning');
    expect(ageTone(7)).toBe('danger');
    expect(ageTone(30)).toBe('danger');
  });
});

describe('filterParams', () => {
  it('uses the contract parameter names and skips empty filters', () => {
    const params = new URLSearchParams();
    filterParams(
      {
        ownerId: 'op-1',
        source: 'instagram',
        closeBefore: '2026-12-31',
        closeAfter: '2026-12-01',
        tagId: 'tag-1',
        createdFrom: '2026-01-01',
        createdTo: '2026-02-01',
      },
      params,
    );
    expect(params.toString()).toBe(
      // The creation range belongs to the board endpoint, not to GET /leads.
      'ownerOperatorId=op-1&source=instagram&closeBefore=2026-12-31&closeAfter=2026-12-01&tagId=tag-1',
    );
    const none = new URLSearchParams();
    filterParams(NO_FILTERS, none);
    expect(none.toString()).toBe('');
  });
});

describe('collapse memory', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is remembered per user and survives broken storage values', () => {
    writeCollapsed('u1', { a: true });
    expect(readCollapsed('u1')).toEqual({ a: true });
    expect(readCollapsed('u2')).toEqual({});
    store.set('agentcore.leads.collapsed.u3', '{oops');
    expect(readCollapsed('u3')).toEqual({});
  });
});
