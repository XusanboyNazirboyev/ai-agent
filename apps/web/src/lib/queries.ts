import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api } from './api';
import type {
  AnalyticsReport,
  ChannelAccount,
  ConversationPage,
  OwnSubscription,
  PipelineView,
} from './types';
import type { TodaySummary } from './today';

/**
 * Owner 2026-11-24 (slow page switches): the main reads of the top-level
 * pages, shared by the pages and by the menu's prefetch-on-hover, so a
 * prefetched answer is exactly the one the page asks for.
 */
export const channelsQuery = queryOptions({
  queryKey: ['channels'],
  queryFn: () => api<{ items: ChannelAccount[] }>('/api/v1/channels'),
});

export const todayQuery = queryOptions({
  queryKey: ['today'],
  queryFn: () => api<TodaySummary>('/api/v1/today'),
});

export const goLiveQuery = queryOptions({
  queryKey: ['go-live'],
  queryFn: () =>
    api<{ missing: ('CATALOG' | 'PROFILE')[] }>(
      '/api/v1/business-profile/readiness',
    ),
});

export const subscriptionQuery = queryOptions({
  queryKey: ['subscription'],
  queryFn: () => api<OwnSubscription>('/api/v1/subscription'),
});

export const pipelinesQuery = queryOptions({
  queryKey: ['pipelines'],
  queryFn: () => api<{ items: PipelineView[] }>('/api/v1/pipelines'),
});

export const waitingCountQuery = queryOptions({
  queryKey: ['conversations', 'waiting-count'],
  queryFn: () =>
    api<ConversationPage>('/api/v1/inbox/conversations?scope=waiting&limit=50'),
});

// The factories return TanStack's own option types (too long to spell out).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function analyticsQuery(range: { from: string; to: string } | null) {
  return queryOptions({
    queryKey: ['analytics', range?.from ?? null, range?.to ?? null],
    queryFn: () =>
      api<AnalyticsReport>(
        `/api/v1/analytics${range ? `?from=${range.from}&to=${range.to}` : ''}`,
      ),
  });
}

/** The inbox list (one page of 25), keyed by every filter the list has. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function conversationsQuery(filters: {
  scope: string;
  q: string;
  language: string;
  score: string;
  tagId: string;
  channelType: string;
}) {
  return infiniteQueryOptions({
    queryKey: [
      'conversations',
      filters.scope,
      filters.q,
      filters.language,
      filters.score,
      filters.tagId,
      filters.channelType,
    ],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ scope: filters.scope, limit: '25' });
      if (pageParam) params.set('cursor', pageParam);
      if (filters.q) params.set('q', filters.q);
      if (filters.language) params.set('language', filters.language);
      if (filters.score) params.set('leadScore', filters.score);
      if (filters.tagId) params.set('tagId', filters.tagId);
      if (filters.channelType) params.set('channelType', filters.channelType);
      return api<ConversationPage>(
        `/api/v1/inbox/conversations?${params.toString()}`,
      );
    },
    getNextPageParam: (last: ConversationPage) => last.nextCursor ?? undefined,
  });
}
