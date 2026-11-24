import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { PAGE_PREFETCH } from './page-prefetch';
import { channelsQuery, conversationsQuery, goLiveQuery } from './queries';

vi.mock('./api', () => ({ api: vi.fn() }));

afterEach(() => vi.mocked(api).mockReset());

describe('menu prefetch (owner 2026-11-24: slow page switches)', () => {
  it('fills exactly the keys the pages read, once per 30 seconds', async () => {
    vi.mocked(api).mockImplementation(
      (path: string) =>
        Promise.resolve(
          path.startsWith('/api/v1/inbox')
            ? { items: [], nextCursor: null }
            : { items: [], missing: [] },
        ) as never,
    );
    const qc = new QueryClient();
    PAGE_PREFETCH.agent!(qc);
    PAGE_PREFETCH.inbox!(qc);
    await vi.waitFor(() => {
      expect(qc.getQueryData(channelsQuery.queryKey)).toBeDefined();
      expect(qc.getQueryData(goLiveQuery.queryKey)).toBeDefined();
      expect(
        qc.getQueryData(
          conversationsQuery({
            scope: 'all',
            q: '',
            language: '',
            score: '',
            tagId: '',
            channelType: '',
          }).queryKey,
        ),
      ).toBeDefined();
    });
    const calls = vi.mocked(api).mock.calls.length;
    PAGE_PREFETCH.agent!(qc);
    PAGE_PREFETCH.inbox!(qc);
    await Promise.resolve();
    expect(vi.mocked(api).mock.calls.length).toBe(calls);
  });
});
