'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { CannedResponse } from './types';

export const CANNED_QUERY = ['canned-responses'] as const;

/** The workspace's quick replies (roadmap P1.8, ADR 070). */
export function useCannedResponses(): {
  items: CannedResponse[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
} {
  const query = useQuery({
    queryKey: CANNED_QUERY,
    queryFn: () => api<{ items: CannedResponse[] }>('/api/v1/canned-responses'),
  });
  return {
    items: query.data?.items ?? [],
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/** The five built-in replies the inbox offers until a workspace writes its own. */
export const BUILT_IN_CANNED = [
  'greeting',
  'wait',
  'details',
  'thanks',
  'bye',
] as const;

/**
 * What the composer offers: the workspace's own replies, or the built-in ones
 * (translated) while it has none.
 */
export function composerReplies(
  own: CannedResponse[],
  t: (key: string) => string,
): CannedResponse[] {
  if (own.length > 0) return own;
  return BUILT_IN_CANNED.map((id, position) => {
    const text = t(`canned.${id}`);
    return { id: `builtin:${id}`, title: text, text, position };
  });
}
