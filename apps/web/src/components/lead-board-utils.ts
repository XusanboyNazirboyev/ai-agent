import {
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type {
  BoardStageView,
  LeadPipelineItem,
  LeadPipelinePage,
} from '@/lib/types';

/** Age chip thresholds (days since the last activity). One place on purpose. */
export const AGE_WARN_DAYS = 3;
export const AGE_DANGER_DAYS = 7;
const DAY_MS = 86_400_000;

export type AgeTone = 'neutral' | 'warning' | 'danger';

export function ageDays(updatedAt: string, now: number = Date.now()): number {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.floor((now - ts) / DAY_MS));
}

export function ageTone(days: number): AgeTone {
  if (days >= AGE_DANGER_DAYS) return 'danger';
  if (days >= AGE_WARN_DAYS) return 'warning';
  return 'neutral';
}

export function stageLabel(
  stage: { code: string | null; name: string | null },
  t: (key: string) => string,
): string {
  return stage.name ?? (stage.code ? t(`leads.stage.${stage.code}`) : '');
}

/** The stage a lead sits in; a lead without a stage shows in the first column. */
export function currentStageId(
  item: LeadPipelineItem,
  stages: BoardStageView[],
): string {
  return item.pipelineStageId ?? stages[0]?.id ?? '';
}

export interface LeadFilters {
  ownerId: string;
  source: string;
  closeBefore: string;
  closeAfter: string;
  tagId: string;
}

export const NO_FILTERS: LeadFilters = {
  ownerId: '',
  source: '',
  closeBefore: '',
  closeAfter: '',
  tagId: '',
};

/** Query params of `GET /leads`, named exactly as the API contract. */
export function filterParams(
  filters: LeadFilters,
  params: URLSearchParams,
): void {
  if (filters.ownerId) params.set('ownerOperatorId', filters.ownerId);
  if (filters.source) params.set('source', filters.source);
  if (filters.closeBefore) params.set('closeBefore', filters.closeBefore);
  if (filters.closeAfter) params.set('closeAfter', filters.closeAfter);
  if (filters.tagId) params.set('tagId', filters.tagId);
}

type LeadsData = InfiniteData<LeadPipelinePage>;

/** Looks a lead up in every cached lead page (board columns and list). */
export function findCachedLead(
  qc: QueryClient,
  id: string,
): LeadPipelineItem | undefined {
  for (const [, data] of qc.getQueriesData<LeadsData>({
    queryKey: ['leads'],
  })) {
    for (const page of data?.pages ?? []) {
      const found = page.items.find((item) => item.id === id);
      if (found) return found;
    }
  }
  return undefined;
}

/** The live copy of a lead from the query cache; `fallback` once it left it. */
export function useCachedLead(
  id: string | null,
  fallback: LeadPipelineItem | null,
): LeadPipelineItem | null {
  const qc = useQueryClient();
  const cached = useSyncExternalStore(
    (notify) => qc.getQueryCache().subscribe(notify),
    () => (id ? findCachedLead(qc, id) : undefined),
    () => undefined,
  );
  return cached ?? fallback;
}

const COLLAPSE_PREFIX = 'agentcore.leads.collapsed.';

export function readCollapsed(userId: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_PREFIX + userId);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

export function writeCollapsed(
  userId: string,
  value: Record<string, boolean>,
): void {
  try {
    window.localStorage.setItem(
      COLLAPSE_PREFIX + userId,
      JSON.stringify(value),
    );
  } catch {
    // Storage blocked: the choice still applies to this page view.
  }
}
