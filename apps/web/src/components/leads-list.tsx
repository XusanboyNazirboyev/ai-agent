'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useRef, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { formatAmount } from '@/lib/currencies';
import type {
  BoardStageView,
  LeadPipelineItem,
  LeadPipelinePage,
} from '@/lib/types';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import {
  ageDays,
  ageTone,
  currentStageId,
  filterParams,
  stageLabel,
  type LeadFilters,
} from './lead-board-utils';

/** Compact list of the pipeline's leads: same filters, same panel. */
export function LeadsList(props: {
  pipelineId: string;
  stages: BoardStageView[];
  filters: LeadFilters;
  onOpen: (item: LeadPipelineItem, opener: HTMLElement | null) => void;
}): ReactNode {
  const { t } = useI18n();
  const query = useInfiniteQuery({
    queryKey: ['leads', 'list', props.pipelineId, props.filters],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        pipelineId: props.pipelineId,
        limit: '25',
      });
      if (pageParam) params.set('cursor', pageParam);
      filterParams(props.filters, params);
      return api<LeadPipelinePage>(`/api/v1/leads?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (query.isPending)
    return (
      <div role="status">
        <span className="sr-only">{t('app.loading')}</span>
        <SkeletonRows rows={4} />
      </div>
    );
  if (query.isError)
    return (
      <div className="flex flex-col items-start gap-3">
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" />
          {t(errorKey(query.error))}
        </p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {t('app.retry')}
        </Button>
      </div>
    );
  if (items.length === 0)
    return (
      <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
        {t('leads.empty')}
      </p>
    );

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul
        aria-label={t('leads.listLabel')}
        data-testid="leads-list"
        className="flex min-w-0 flex-col divide-y divide-line rounded-2xl border border-line bg-surface"
      >
        {items.map((item) => (
          <ListRow
            key={item.id}
            item={item}
            stages={props.stages}
            onOpen={props.onOpen}
          />
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('list.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function ListRow(props: {
  item: LeadPipelineItem;
  stages: BoardStageView[];
  onOpen: (item: LeadPipelineItem, opener: HTMLElement | null) => void;
}): ReactNode {
  const { t } = useI18n();
  const { item } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const stage = props.stages.find(
    (s) => s.id === currentStageId(item, props.stages),
  );
  const name = item.contact.name ?? t('list.unnamed');
  const days = ageDays(item.updatedAt);
  const tone = ageTone(days);
  const locale = t('locale.uz-Latn') === 'uz-Latn' ? 'uz-Latn' : undefined;
  return (
    <li
      data-testid="lead-list-row"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
    >
      <button
        ref={ref}
        type="button"
        data-testid="lead-list-open"
        data-lead-open={item.id}
        aria-label={t('leads.openLead', { name })}
        onClick={() => props.onOpen(item, ref.current)}
        className="min-h-9 min-w-0 flex-1 basis-40 truncate text-left text-sm font-semibold hover:text-primary-fg"
      >
        {name}
      </button>
      {stage ? (
        <Badge
          tone={
            stage.kind === 'WON'
              ? 'success'
              : stage.kind === 'LOST'
                ? 'danger'
                : 'accent'
          }
          data-testid="lead-list-stage"
        >
          {stageLabel(stage, t)}
        </Badge>
      ) : null}
      <span
        className="min-w-0 text-sm font-medium"
        data-testid="lead-list-amount"
      >
        {item.amount ? formatAmount(item.amount, item.currency, locale) : ''}
      </span>
      {item.owner ? (
        <span
          role="img"
          title={item.owner.displayName}
          aria-label={t('leads.ownerLabel', { name: item.owner.displayName })}
        >
          <Avatar name={item.owner.displayName} size="xs" />
        </span>
      ) : null}
      {stage && stage.kind === 'OPEN' ? (
        <Badge tone={tone} dot={tone !== 'neutral'} data-testid="lead-list-age">
          <span aria-hidden="true">{t('leads.ageDays', { days })}</span>
          <span className="sr-only">{t('leads.ageLabel', { days })}</span>
        </Badge>
      ) : null}
    </li>
  );
}
