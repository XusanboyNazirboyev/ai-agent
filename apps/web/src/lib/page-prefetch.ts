import type {
  FetchQueryOptions,
  QueryClient,
  QueryKey,
} from '@tanstack/react-query';
import type { NavKey } from './nav';
import {
  channelsQuery,
  conversationsQuery,
  goLiveQuery,
  pipelinesQuery,
  subscriptionQuery,
  todayQuery,
  waitingCountQuery,
} from './queries';

/** A hover within this long of the last answer fetches nothing new. */
const FRESH_MS = 30_000;

function warm<TData, TKey extends QueryKey>(
  qc: QueryClient,
  options: FetchQueryOptions<TData, Error, TData, TKey>,
): void {
  void qc.prefetchQuery({ ...options, staleTime: FRESH_MS });
}

/**
 * Owner 2026-11-24 (slow page switches): pointing at a menu item starts the
 * page's own first reads, so the page opens with its data already here.
 */
export const PAGE_PREFETCH: Partial<Record<NavKey, (qc: QueryClient) => void>> =
  {
    agent: (qc) => {
      warm(qc, channelsQuery);
      warm(qc, goLiveQuery);
    },
    today: (qc) => {
      warm(qc, todayQuery);
      warm(qc, channelsQuery);
    },
    inbox: (qc) => {
      void qc.prefetchInfiniteQuery({
        ...conversationsQuery({
          scope: 'all',
          q: '',
          language: '',
          score: '',
          tagId: '',
          channelType: '',
        }),
        staleTime: FRESH_MS,
      });
      warm(qc, channelsQuery);
      warm(qc, waitingCountQuery);
    },
    crm: (qc) => warm(qc, pipelinesQuery),
    billing: (qc) => warm(qc, subscriptionQuery),
  };
