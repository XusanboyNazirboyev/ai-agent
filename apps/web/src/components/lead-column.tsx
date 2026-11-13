'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { formatAmount } from '@/lib/currencies';
import { LEAD_AMOUNT_ENABLED } from '@/lib/lead-fields';
import type {
  BoardStageView,
  LeadPipelineItem,
  LeadPipelinePage,
} from '@/lib/types';
import { Button } from './ui/button';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { LeadCard } from './lead-card';
import { filterParams, stageLabel, type LeadFilters } from './lead-board-utils';

const ACCENT: Record<BoardStageView['kind'], string> = {
  OPEN: 'border-t-primary',
  WON: 'border-t-success-fg',
  LOST: 'border-t-danger',
};

/** Count and one total per currency, as decimal strings (never summed here). */
export function StageTotals(props: { stage: BoardStageView }): ReactNode {
  const { t } = useI18n();
  const locale = t('locale.uz-Latn') === 'uz-Latn' ? 'uz-Latn' : undefined;
  return (
    <>
      {props.stage.totals.map((total) => (
        <span
          key={total.currency}
          data-testid="lead-column-total"
          className="min-w-0 break-words text-xs font-medium text-muted"
        >
          {formatAmount(total.amount, total.currency, locale)}
        </span>
      ))}
    </>
  );
}

export function LeadColumn(props: {
  stage: BoardStageView;
  pipelineId: string;
  stages: BoardStageView[];
  filters: LeadFilters;
  collapsed: boolean;
  /** Below md: one column at a time, full width, no collapse toggle. */
  single?: boolean;
  onToggleCollapsed: () => void;
  draggedId: string | null;
  draggedToStageId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOver: (stageId: string | null) => void;
  onDrop: (targetStageId: string) => void;
  onSwipe: (item: LeadPipelineItem, direction: 'next' | 'prev') => void;
  onOpen: (item: LeadPipelineItem, opener: HTMLElement | null) => void;
  onRequestMove: (item: LeadPipelineItem, toStageId: string) => void;
  onAnnounce: (message: string) => void;
  /** Opens the add-lead dialog on this stage (open stages, editors only). */
  onAdd?: (stageId: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const listId = useId();
  const { stage } = props;
  const terminal = stage.kind !== 'OPEN';
  const name = stageLabel(stage, t);
  const query = useInfiniteQuery({
    queryKey: ['leads', 'stage', stage.id, props.pipelineId, props.filters],
    enabled: !props.collapsed,
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        pipelineId: props.pipelineId,
        stageId: stage.id,
        limit: '25',
      });
      if (pageParam) params.set('cursor', pageParam);
      filterParams(props.filters, params);
      return api<LeadPipelinePage>(`/api/v1/leads?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const isDraggingInto =
    props.draggedId !== null && props.draggedToStageId === stage.id;

  return (
    <section
      aria-label={name}
      data-testid={`lead-column-${stage.code ?? stage.id}`}
      data-collapsed={props.collapsed ? 'true' : 'false'}
      data-stage-drop={stage.id}
      className={`flex shrink-0 flex-col self-start rounded-2xl border border-t-[3px] border-line bg-surface shadow-card ${ACCENT[stage.kind]} ${
        props.single
          ? 'w-full'
          : props.collapsed
            ? 'w-[min(85vw,14rem)] md:w-56'
            : 'w-[min(85vw,21rem)] md:w-80'
      } ${isDraggingInto ? 'bg-primary-soft ring-2 ring-primary' : ''}`}
    >
      <header className="flex min-w-0 flex-col gap-1 border-b border-line px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {name}
          </h2>
          <span
            data-testid="lead-count"
            className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted"
          >
            {stage.count}
          </span>
          {props.onAdd && !terminal ? (
            <button
              type="button"
              data-testid="lead-column-add"
              aria-label={t('leads.addToStage', { stage: name })}
              onClick={() => props.onAdd?.(stage.id)}
              className="grid min-h-9 min-w-9 place-items-center rounded-lg text-muted hover:bg-surface-2"
            >
              <Icon name="plus" className="h-4 w-4" />
            </button>
          ) : null}
          {terminal && !props.single ? (
            <button
              type="button"
              data-testid="lead-column-toggle"
              aria-expanded={!props.collapsed}
              aria-controls={listId}
              aria-label={t('leads.toggleColumn', { stage: name })}
              onClick={props.onToggleCollapsed}
              className="grid min-h-9 min-w-9 place-items-center rounded-lg text-muted hover:bg-surface-2"
            >
              <span
                aria-hidden="true"
                className={props.collapsed ? '-rotate-90' : ''}
              >
                ▾
              </span>
            </button>
          ) : null}
        </div>
        {LEAD_AMOUNT_ENABLED && stage.totals.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5">
            <StageTotals stage={stage} />
          </div>
        ) : null}
      </header>
      <ul
        id={listId}
        className={`min-h-0 flex-col gap-2 p-2 ${props.collapsed ? 'hidden' : 'flex'}`}
      >
        {query.isPending && !props.collapsed ? (
          <li role="status">
            <span className="sr-only">{t('app.loading')}</span>
            <SkeletonRows rows={2} />
          </li>
        ) : null}
        {query.isError ? (
          <li className="flex flex-col items-start gap-3">
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
          </li>
        ) : null}
        {query.isSuccess && items.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-muted">
            {t('leads.empty')}
          </li>
        ) : null}
        {items.map((item) => (
          <LeadCard
            key={item.id}
            item={item}
            stage={stage}
            stages={props.stages}
            draggedId={props.draggedId}
            draggedToStageId={props.draggedToStageId}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onDragOver={props.onDragOver}
            onDrop={props.onDrop}
            swipe={!!props.single}
            onSwipe={props.onSwipe}
            onOpen={props.onOpen}
            onRequestMove={props.onRequestMove}
            onAnnounce={props.onAnnounce}
          />
        ))}
        {query.hasNextPage ? (
          <li>
            <Button
              className="w-full"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? t('app.loading') : t('list.loadMore')}
            </Button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
