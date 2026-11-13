'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { downloadCsv } from '@/lib/export-csv';
import { useToast } from '@/components/ui/toast';
import { channelName } from '@/lib/channel-names';
import type {
  BoardStageView,
  ConversationState,
  LeadPipelineItem,
  LeadPipelinePage,
  LeadScore,
  PipelineView,
  Tag,
} from '@/lib/types';
import { formatAmount } from '@/lib/currencies';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { LeadOpportunity } from './lead-opportunity';

const STATE_TONE: Record<ConversationState, Tone> = {
  BOT_ACTIVE: 'neutral',
  WAITING_OPERATOR: 'warning',
  OPERATOR_ACTIVE: 'accent',
  CLOSED: 'neutral',
};
/** Who answers the customer now (bot or a person); none once closed. */
const OWNER_ICON: Record<ConversationState, string> = {
  BOT_ACTIVE: '🤖',
  WAITING_OPERATOR: '👤',
  OPERATOR_ACTIVE: '👤',
  CLOSED: '',
};
const SCORE_TONE: Record<LeadScore, Tone> = {
  HOT: 'danger',
  WARM: 'warning',
  COLD: 'neutral',
};

function stageName(
  stage: { code: string | null; name: string | null },
  t: (key: string) => string,
): string {
  return stage.name ?? (stage.code ? t(`leads.stage.${stage.code}`) : '');
}

/** Tenant-configured funnels; lead score remains a separate attribute.
 * ADR 057: every pipeline has its own stages, and the board shows one
 * pipeline at a time. */
export function LeadsBoard(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const { operator } = useShell();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const canExport = operator.role === 'OWNER' || operator.role === 'ADMIN';

  const pipelines = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api<{ items: PipelineView[] }>('/api/v1/pipelines'),
  });
  const list = pipelines.data?.items ?? [];
  const urlPipeline = params.get('pipeline');
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (list.length === 0) return;
    const valid = list.find((p) => p.id === urlPipeline);
    if (valid) {
      setActiveId(valid.id);
      return;
    }
    const def = list.find((p) => p.isDefault);
    setActiveId((def ?? list[0]).id);
  }, [list, urlPipeline]);

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const active = list.find((p) => p.id === activeId) ?? list[0];
  const board = useQuery({
    queryKey: ['board', active?.id, fromDate, toDate],
    enabled: !!active,
    queryFn: () => {
      const qs = new URLSearchParams();
      if (fromDate) qs.set('from', fromDate);
      if (toDate) qs.set('to', toDate);
      return api<{ stages: BoardStageView[] }>(
        `/api/v1/pipelines/${active!.id}/board?${qs.toString()}`,
      );
    },
  });
  const columns = board.data?.stages ?? [];

  const [ownerId, setOwnerId] = useState('');
  const [source, setSource] = useState('');
  const [closeBefore, setCloseBefore] = useState('');
  const [closeAfter, setCloseAfter] = useState('');
  const [tagId, setTagId] = useState('');
  const filters: LeadFilters = {
    ownerId,
    source,
    closeBefore,
    closeAfter,
    tagId,
  };

  // Drag-and-drop / keyboard move state. `draggedId` is the lead being moved;
  // `draggedToStageId` is the column the drop would target.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [draggedToStageId, setDraggedToStageId] = useState<string | null>(null);
  const [dragStatus, setDragStatus] = useState('');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [mobileStageId, setMobileStageId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const onResize = () =>
      setIsMobile(typeof window !== 'undefined' && window.innerWidth < 768);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Lost-reason state shared by the stage select and drag-to-LOST.
  const [lostDialog, setLostDialog] = useState(false);
  const [lostReasonDraft, setLostReasonDraft] = useState('');
  const [lostLeadId, setLostLeadId] = useState<string | null>(null);
  const [lostTargetStageId, setLostTargetStageId] = useState<string | null>(
    null,
  );

  const move = useMutation({
    mutationFn: (input: {
      leadId: string;
      stageId: string;
      lostReason?: string;
    }) =>
      api(`/api/v1/leads/${input.leadId}/stage`, {
        method: 'PATCH',
        body:
          input.lostReason !== undefined
            ? { stageId: input.stageId, lostReason: input.lostReason }
            : { stageId: input.stageId },
      }),
    onSettled: () => {
      void queryClient
        .invalidateQueries({ queryKey: ['leads'] })
        .finally(() => {
          setLostDialog(false);
          setLostLeadId(null);
          setLostTargetStageId(null);
          setLostReasonDraft('');
        });
    },
    onError: () => {
      setLostDialog(false);
      setLostLeadId(null);
      setLostTargetStageId(null);
      setLostReasonDraft('');
    },
  });

  function choose(next: PipelineView): void {
    setActiveId(next.id);
    router.replace(`/leads?view=funnel&pipeline=${next.id}`, { scroll: false });
  }

  function handleDragStart(id: string): void {
    setDraggedId(id);
    setDragStatus(t('leads.dragPickedUp'));
  }
  function handleDragEnd(): void {
    setDraggedId(null);
    setDraggedToStageId(null);
    setDragStatus('');
  }
  function handleDrop(targetStageId: string): void {
    if (!draggedId) return;
    const target = columns.find((s) => s.id === targetStageId);
    if (target?.kind === 'LOST') {
      setDraggedToStageId(targetStageId);
      setLostLeadId(draggedId);
      setLostTargetStageId(targetStageId);
      setLostReasonDraft('');
      setLostDialog(true);
      setDraggedId(null);
      setDragStatus(t('leads.dragDroppedLost'));
      return;
    }
    move.mutate({ leadId: draggedId, stageId: targetStageId });
    setDraggedId(null);
    setDraggedToStageId(null);
    setDragStatus(t('leads.dragDropped'));
  }
  const rows = columns;
  const switcher = (
    <div
      role="group"
      aria-label={t('pipelines.switcher')}
      className="flex min-w-0 flex-wrap items-center gap-1 rounded-xl border border-line bg-surface p-1"
    >
      {list.map((pipeline) => (
        <button
          key={pipeline.id}
          type="button"
          aria-pressed={pipeline.id === active?.id}
          disabled={pipeline.id === active?.id}
          onClick={() => choose(pipeline)}
          className={`min-h-9 max-w-[14rem] truncate rounded-lg px-3 text-sm font-medium transition-colors ${
            pipeline.id === active?.id
              ? 'bg-primary text-white'
              : 'text-muted hover:bg-surface-2 hover:text-fg'
          }`}
        >
          {pipeline.name ?? t('pipeline.defaultName')}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3 sm:p-4">
      <div aria-live="polite" className="sr-only">
        {dragStatus}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <p className="min-w-0 flex-1 basis-56 text-sm text-muted">
          {t('leads.funnelIntro')}
        </p>
        <div className="flex min-w-0 flex-1 basis-72 sm:max-w-xs">
          {list.length > 1 ? (
            switcher
          ) : (
            <p
              data-testid="pipelines-single"
              className="truncate rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted"
            >
              {active?.name ?? t('pipeline.defaultName')}
            </p>
          )}
        </div>
        {canExport ? (
          <Button
            size="sm"
            variant="secondary"
            loading={exporting}
            data-testid="leads-export"
            className="min-w-0 max-w-full"
            onClick={() => {
              const qs = new URLSearchParams();
              if (tagId) qs.set('tagId', tagId);
              const query = qs.toString();
              setExporting(true);
              void downloadCsv(
                `/api/v1/exports/leads.csv${query ? `?${query}` : ''}`,
                'leads.csv',
              )
                .then(() => toast(t('toast.exportStarted')))
                .catch((e: unknown) => toast(t(errorKey(e))))
                .finally(() => setExporting(false));
            }}
          >
            {t('export.leads')}
          </Button>
        ) : null}
      </div>
      <div
        role="group"
        aria-label={t('leads.views')}
        className="flex min-w-0 gap-1 rounded-xl border border-line bg-surface p-1"
        data-testid="leads-view-toggle"
      >
        <button
          type="button"
          aria-pressed={view === 'board'}
          onClick={() => setView('board')}
          className={`min-h-9 rounded-lg px-3 text-sm font-medium transition-colors ${
            view === 'board'
              ? 'bg-primary text-white'
              : 'text-muted hover:bg-surface-2 hover:text-fg'
          }`}
        >
          {t('leads.view.funnel')}
        </button>
        <button
          type="button"
          aria-pressed={view === 'list'}
          onClick={() => setView('list')}
          className={`min-h-9 rounded-lg px-3 text-sm font-medium transition-colors ${
            view === 'list'
              ? 'bg-primary text-white'
              : 'text-muted hover:bg-surface-2 hover:text-fg'
          }`}
        >
          {t('leads.view.list')}
        </button>
      </div>
      <LeadsFilters
        filters={filters}
        onChange={(next) => {
          setOwnerId(next.ownerId);
          setSource(next.source);
          setCloseBefore(next.closeBefore);
          setCloseAfter(next.closeAfter);
          setTagId(next.tagId);
        }}
        onClear={() => {
          setOwnerId('');
          setSource('');
          setCloseBefore('');
          setCloseAfter('');
          setTagId('');
        }}
      />
      {board.isSuccess && columns.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-surface p-3">
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-sm text-muted">
            <label className="sr-only">{t('leads.funnelRange')}</label>
            <div className="flex gap-2">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className={fieldClass}
                aria-label={t('leads.funnelFrom')}
              />
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className={fieldClass}
                aria-label={t('leads.funnelTo')}
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
            {columns.map((stage) => {
              const total = columns.reduce((sum, s) => sum + s.count, 0);
              const share =
                total === 0 ? 0 : Math.round((stage.count / total) * 100);
              const selected = mobileStageId === stage.id;
              return (
                <div
                  key={stage.id}
                  onClick={() => setMobileStageId(stage.id)}
                  className={`flex flex-col items-center gap-1 text-xs cursor-pointer ${selected ? 'bg-primary-soft text-primary-fg' : ''}`}
                  data-testid="funnel-stage"
                >
                  <span className="truncate" title={stageName(stage, t)}>
                    {stageName(stage, t)}
                  </span>
                  <span className="font-semibold">{stage.count}</span>
                  <span className="text-muted">{share}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {board.isPending ? (
        <div role="status">
          <span className="sr-only">{t('app.loading')}</span>
          <SkeletonRows rows={3} />
        </div>
      ) : null}
      {board.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" />
            {t(errorKey(board.error))}
          </p>
          <Button size="sm" onClick={() => void board.refetch()}>
            {t('app.retry')}
          </Button>
        </div>
      ) : null}
      {board.isSuccess && rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
          {t('leads.empty')}
        </p>
      ) : null}
      {board.isSuccess && rows.length > 0 ? (
        <div
          aria-label={t('leads.columns')}
          className={`relative flex min-h-0 min-w-0 max-w-full items-stretch gap-3 pb-2 ${
            view === 'board' ? 'flex overflow-x-auto' : 'flex-col'
          }`}
        >
          {(() => {
            const visible =
              view === 'board'
                ? rows.filter(
                    (stage) =>
                      !isMobile ||
                      mobileStageId === null ||
                      stage.id === mobileStageId,
                  )
                : rows;
            return (
              <>
                {view === 'board' &&
                isMobile &&
                columns.length > 0 &&
                mobileStageId === null ? (
                  <p className="text-xs text-muted px-3">
                    {t('leads.pickStage')}
                  </p>
                ) : null}
                {visible.map((stage) => (
                  <LeadColumn
                    key={stage.id}
                    stage={stage}
                    pipelineId={active!.id}
                    stages={rows}
                    filters={filters}
                    draggedId={draggedId}
                    draggedToStageId={draggedToStageId}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragOverStage={(id) => setDraggedToStageId(id)}
                    onDragLeaveStage={() => setDraggedToStageId(null)}
                    onDrop={handleDrop}
                    onMove={(leadId, stageId) =>
                      move.mutate({ leadId, stageId })
                    }
                    onLostStage={(leadId, stageId) => {
                      setLostLeadId(leadId);
                      setLostTargetStageId(stageId);
                      setLostReasonDraft('');
                      setLostDialog(true);
                    }}
                  />
                ))}
              </>
            );
          })()}
        </div>
      ) : null}

      <FormDialog
        open={lostDialog}
        title={t('opportunity.lostReason')}
        description={t('opportunity.lostReasonBody')}
        testId="lead-lost-dialog"
        onClose={() => {
          setLostDialog(false);
          setLostLeadId(null);
          setLostTargetStageId(null);
          setLostReasonDraft('');
        }}
        onSubmit={() => {
          const reason = lostReasonDraft.trim();
          if (!reason || !lostLeadId || !lostTargetStageId) return;
          move.mutate({
            leadId: lostLeadId,
            stageId: lostTargetStageId,
            lostReason: reason,
          });
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setLostDialog(false);
                setLostLeadId(null);
                setLostTargetStageId(null);
                setLostReasonDraft('');
              }}
            >
              {t('app.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={move.isPending}>
              {t('app.save')}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('opportunity.lostReason')}
          <input
            value={lostReasonDraft}
            onChange={(e) => setLostReasonDraft(e.target.value)}
            maxLength={200}
            className={fieldClass}
            autoFocus
            aria-label={t('opportunity.lostReason')}
          />
        </label>
      </FormDialog>
    </div>
  );
}

function LeadColumn(props: {
  stage: BoardStageView;
  pipelineId: string;
  stages: BoardStageView[];
  filters: LeadFilters;
  draggedId: string | null;
  draggedToStageId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverStage: (stageId: string) => void;
  onDragLeaveStage: () => void;
  onDrop: (targetStageId: string) => void;
  onMove: (leadId: string, stageId: string) => void;
  onLostStage: (leadId: string, stageId: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const query = useInfiniteQuery({
    queryKey: ['leads', props.stage.id, props.pipelineId, props.filters],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        pipelineId: props.pipelineId,
        stageId: props.stage.id,
        limit: '25',
      });
      if (pageParam) params.set('cursor', pageParam);
      if (props.filters.ownerId)
        params.set('ownerOperatorId', props.filters.ownerId);
      if (props.filters.source) params.set('source', props.filters.source);
      if (props.filters.closeBefore)
        params.set('closeBefore', props.filters.closeBefore);
      if (props.filters.closeAfter)
        params.set('closeAfter', props.filters.closeAfter);
      if (props.filters.tagId) params.set('tagId', props.filters.tagId);
      return api<LeadPipelinePage>(`/api/v1/leads?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const count = query.hasNextPage ? `${items.length}+` : String(items.length);
  const name = stageName(props.stage, t);
  const terminal = props.stage.kind !== 'OPEN';
  const columnTone: Record<'WON' | 'LOST', string> = {
    WON: 'success',
    LOST: 'danger',
  };
  const [dragOver, setDragOver] = useState(false);
  const isDraggingInto =
    props.draggedId !== null && props.draggedToStageId === props.stage.id;

  return (
    <section
      aria-label={name}
      data-testid={`lead-column-${props.stage.code ?? props.stage.id}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
        props.onDragOverStage(props.stage.id);
      }}
      onDragLeave={() => {
        setDragOver(false);
        props.onDragLeaveStage();
      }}
      onDrop={() => {
        setDragOver(false);
        props.onDrop(props.stage.id);
      }}
      className={`flex w-[min(85vw,21rem)] min-w-[min(85vw,21rem)] shrink-0 flex-col rounded-2xl border border-line bg-surface shadow-card md:w-80 md:min-w-80 ${terminal ? 'hidden md:flex' : ''} ${terminal ? `border-${columnTone[props.stage.kind as 'WON' | 'LOST']}` : ''} ${dragOver ? 'border-primary ring-2 ring-primary' : ''} ${isDraggingInto ? 'bg-primary-soft' : ''}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate font-semibold">{name}</h2>
          {terminal ? (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${columnTone[props.stage.kind as 'WON' | 'LOST'] === 'success' ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg'}`}
            >
              {t(`leads.stage.${props.stage.code}`)}
            </span>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          {query.isSuccess ? (
            <>
              <span
                data-testid="lead-count"
                className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted"
              >
                {count}
              </span>
              {props.stage.totals.map((total) => (
                <div
                  key={total.currency}
                  className="text-xs text-muted leading-tight"
                  data-testid="lead-column-total"
                >
                  {total.currency} {formatAmount(total.amount, total.currency)}
                </div>
              ))}
            </>
          ) : null}
        </div>
      </header>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {query.isPending ? (
          <li role="status">
            <span className="sr-only">{t('app.loading')}</span>
            <SkeletonRows rows={3} />
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
          <li className="px-3 py-8 text-center text-sm text-muted">
            {t('leads.empty')}
          </li>
        ) : null}
        {items.map((item) => (
          <LeadCard
            key={item.id}
            item={item}
            currentStageId={props.stage.id}
            stages={props.stages}
            pipelineId={props.pipelineId}
            draggedId={props.draggedId}
            draggedToStageId={props.draggedToStageId}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onMove={(leadId, stageId) => props.onMove(leadId, stageId)}
            onLostStage={(leadId, stageId) =>
              props.onLostStage(leadId, stageId)
            }
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

function LeadCard(props: {
  item: LeadPipelineItem;
  currentStageId: string;
  stages: BoardStageView[];
  pipelineId: string;
  draggedId: string | null;
  draggedToStageId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMove: (leadId: string, stageId: string) => void;
  onLostStage: (leadId: string, stageId: string) => void;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { timeZone, operator } = useShell();
  const canEdit = ['OWNER', 'ADMIN', 'OPERATOR'].includes(operator.role);
  const canAct = operator.role !== 'VIEWER';
  const isDragging = props.draggedId === props.item.id;
  const isDraggedHere = props.draggedToStageId === props.currentStageId;
  // Optimistic stage selection while move is in flight/refetching.
  const [stageChoice, setStageChoice] = useState<string | null>(null);
  // Keyboard drag state: Space picks up, arrows move target, Space drops, Escape cancels.
  const [keyboardDragging, setKeyboardDragging] = useState(false);
  const [keyboardTargetStage, setKeyboardTargetStage] = useState<string | null>(
    null,
  );

  const acceptSuggestion = useMutation({
    mutationFn: () =>
      api(`/api/v1/leads/${props.item.id}/stage-suggestion/accept`, {
        method: 'POST',
      }),
  });
  const dismissSuggestion = useMutation({
    mutationFn: () =>
      api(`/api/v1/leads/${props.item.id}/stage-suggestion/dismiss`, {
        method: 'POST',
      }),
  });
  const handBackToAi = useMutation({
    mutationFn: () =>
      api(`/api/v1/leads/${props.item.id}/hand-back-to-ai`, {
        method: 'POST',
      }),
  });

  useEffect(() => {
    if (stageChoice && props.currentStageId === stageChoice) {
      setStageChoice(null);
    }
  }, [props.currentStageId, stageChoice]);

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (!canEdit) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!keyboardDragging) {
        setKeyboardDragging(true);
        setKeyboardTargetStage(props.currentStageId);
      } else {
        const target = keyboardTargetStage ?? props.currentStageId;
        const stage = props.stages.find((s) => s.id === target);
        if (stage?.kind === 'LOST') {
          setKeyboardDragging(false);
          props.onLostStage(props.item.id, target);
        } else {
          props.onMove(props.item.id, target);
          setKeyboardDragging(false);
          setKeyboardTargetStage(null);
        }
      }
      return;
    }
    if (!keyboardDragging) return;
    if (e.key === 'Escape') {
      setKeyboardDragging(false);
      setKeyboardTargetStage(null);
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const idx = props.stages.findIndex(
        (s) => s.id === (keyboardTargetStage ?? props.currentStageId),
      );
      const next =
        idx === -1
          ? 0
          : Math.min(
              Math.max(idx + (e.key === 'ArrowRight' ? 1 : -1), 0),
              props.stages.length - 1,
            );
      setKeyboardTargetStage(props.stages[next].id);
    }
  }
  const name = props.item.contact.name ?? t('list.unnamed');
  const stageValue = stageChoice ?? props.currentStageId;

  return (
    <li>
      <article
        data-testid="lead-card"
        role="button"
        aria-label={t('leads.cardAriaLabel', { name })}
        tabIndex={canEdit ? 0 : -1}
        draggable={canEdit}
        onDragStart={() => props.onDragStart(props.item.id)}
        onDragEnd={props.onDragEnd}
        onKeyDown={handleKeyDown}
        className={`flex min-w-0 flex-col gap-2 rounded-xl border border-line p-3 ${isDragging ? 'bg-primary-soft border-primary ring-1 ring-primary' : 'bg-canvas'} ${isDraggedHere ? 'border-primary ring-2 ring-primary' : 'border-line'}`}
      >
        <Link
          href={`/inbox?scope=all&c=${props.item.conversation.id}`}
          className="flex min-w-0 items-start gap-3 hover:text-primary-fg"
        >
          <Avatar name={name} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="truncate font-medium">{name}</span>
            {props.item.contact.phone ? (
              <span className="truncate text-sm text-muted">
                {props.item.contact.phone}
              </span>
            ) : null}
            <span className="flex flex-wrap items-center gap-1.5">
              {props.item.score ? (
                <Badge tone={SCORE_TONE[props.item.score]} dot>
                  {t(`score.${props.item.score}`)}
                </Badge>
              ) : null}
              {props.item.stageSetBy === 'AGENT' ? (
                <Badge tone="neutral" data-testid="lead-card-stage-by-ai">
                  {t('leads.stageByAI')}
                </Badge>
              ) : null}
              {props.item.suggestedStageId ? (
                <Badge tone="warning" data-testid="lead-card-stage-suggested">
                  {t('leads.stageSuggested')}
                </Badge>
              ) : null}
              <Badge tone={STATE_TONE[props.item.conversation.state]} dot>
                {OWNER_ICON[props.item.conversation.state] ? (
                  <span aria-hidden="true" data-testid="lead-card-owner">
                    {OWNER_ICON[props.item.conversation.state]}
                  </span>
                ) : null}
                {t(`state.${props.item.conversation.state}`)}
              </Badge>
              <Badge tone="neutral">
                <span data-testid="lead-card-channel">
                  {channelName(props.item.conversation.channelType)}
                </span>
              </Badge>
              {(props.item.tags ?? []).map((tag) => (
                <Badge key={tag.id} data-testid="lead-card-tag">
                  {tag.name}
                </Badge>
              ))}
              {props.item.amount ? (
                <Badge tone="accent" data-testid="lead-card-amount">
                  {formatAmount(
                    props.item.amount,
                    props.item.currency,
                    t('locale.uz-Latn') === 'uz-Latn' ? 'uz-Latn' : undefined,
                  )}
                </Badge>
              ) : null}
              {props.item.owner ? (
                <span
                  data-testid="lead-card-owner-name"
                  className="truncate text-xs text-muted"
                >
                  {props.item.owner.displayName}
                </span>
              ) : null}
              {props.item.expectedCloseDate ? (
                <span
                  data-testid="lead-card-close"
                  className="truncate text-xs text-muted"
                >
                  {t('opportunity.closeDate', {
                    date: props.item.expectedCloseDate,
                  })}
                </span>
              ) : null}
            </span>
            <span className="text-xs text-muted">
              {t('leads.updated', {
                date: formatDateTime(props.item.updatedAt, timeZone),
              })}
            </span>
          </span>
        </Link>
        {canEdit ? (
          <LeadOpportunity leadId={props.item.id} item={props.item} />
        ) : null}
        {canEdit ? (
          <label className="flex flex-col gap-1 text-xs text-muted">
            {t('leads.moveToStage')}
            <select
              aria-label={t('leads.moveToStage')}
              data-testid="lead-card-stage"
              value={stageValue}
              disabled={false}
              onChange={(event) => {
                const value = event.target.value;
                const target = props.stages.find((s) => s.id === value);
                setStageChoice(value);
                if (target?.kind === 'LOST') {
                  props.onLostStage(props.item.id, value);
                  return;
                }
                props.onMove(props.item.id, value);
              }}
              className="min-h-9 rounded-lg border border-line bg-surface px-2 text-sm text-fg"
            >
              {props.stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stageName(stage, t)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {canAct ? (
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {props.item.suggestedStageId &&
            props.item.suggestedStageId !== props.currentStageId ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => acceptSuggestion.mutate()}
                  disabled={acceptSuggestion.isPending}
                  data-testid="lead-accept-suggestion"
                >
                  {t('leads.acceptSuggestion')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dismissSuggestion.mutate()}
                  disabled={dismissSuggestion.isPending}
                  data-testid="lead-dismiss-suggestion"
                >
                  {t('leads.dismissSuggestion')}
                </Button>
              </>
            ) : null}
            {props.item.stageSetBy === 'OPERATOR' && canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handBackToAi.mutate()}
                disabled={handBackToAi.isPending}
                data-testid="lead-hand-back-to-ai"
              >
                {t('leads.handBackToAi')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </article>
    </li>
  );
}

interface LeadFilters {
  ownerId: string;
  source: string;
  closeBefore: string;
  closeAfter: string;
  tagId: string;
}

/** ADR 057: the API filters the leads list, so the web only sends filters. */
function LeadsFilters(props: {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  onClear: () => void;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();

  const team = useQuery({
    queryKey: ['team'],
    queryFn: () =>
      api<{
        operators: { id: string; displayName: string; isActive: boolean }[];
      }>('/api/v1/team'),
    enabled: operator.role === 'OWNER' || operator.role === 'ADMIN',
  });
  const tags = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ items: Tag[] }>('/api/v1/tags'),
  });

  const active = Object.values(props.filters).some((v) => v);
  const update = (patch: Partial<LeadFilters>): void => {
    props.onChange({ ...props.filters, ...patch });
  };

  return (
    <div
      data-testid="leads-filters"
      className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-surface p-3"
    >
      {operator.role === 'OWNER' || operator.role === 'ADMIN' ? (
        <label className="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-sm font-medium">
          <span className="sr-only">{t('leads.filterOwner')}</span>
          <select
            aria-label={t('leads.filterOwner')}
            value={props.filters.ownerId}
            onChange={(e) => update({ ownerId: e.target.value })}
            className={fieldClass}
          >
            <option value="">{t('leads.anyOwner')}</option>
            {(team.data?.operators ?? [])
              .filter((o) => o.isActive)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      <label className="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-sm font-medium">
        <span className="sr-only">{t('leads.filterSource')}</span>
        <input
          aria-label={t('leads.filterSource')}
          value={props.filters.source}
          maxLength={60}
          onChange={(e) => update({ source: e.target.value })}
          className={fieldClass}
        />
      </label>
      <label className="flex min-w-0 flex-1 basis-36 flex-col gap-1 text-sm font-medium">
        <span className="sr-only">{t('leads.filterCloseBefore')}</span>
        <input
          type="date"
          aria-label={t('leads.filterCloseBefore')}
          value={props.filters.closeBefore}
          onChange={(e) => update({ closeBefore: e.target.value })}
          className={fieldClass}
        />
      </label>
      <label className="flex min-w-0 flex-1 basis-36 flex-col gap-1 text-sm font-medium">
        <span className="sr-only">{t('leads.filterCloseAfter')}</span>
        <input
          type="date"
          aria-label={t('leads.filterCloseAfter')}
          value={props.filters.closeAfter}
          onChange={(e) => update({ closeAfter: e.target.value })}
          className={fieldClass}
        />
      </label>
      <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm font-medium">
        <span className="sr-only">{t('people.filterByTag')}</span>
        <select
          aria-label={t('people.filterByTag')}
          value={props.filters.tagId}
          onChange={(e) => update({ tagId: e.target.value })}
          className={fieldClass}
        >
          <option value="">{t('people.allTags')}</option>
          {(tags.data?.items ?? []).map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          icon="x"
          disabled={!active}
          onClick={props.onClear}
        >
          {t('leads.clearFilters')}
        </Button>
      </div>
    </div>
  );
}
