'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { downloadCsv } from '@/lib/export-csv';
import { useToast } from '@/components/ui/toast';
import type {
  BoardStageView,
  LeadPipelineItem,
  PipelineView,
} from '@/lib/types';
import { useShell } from './app-shell';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import {
  NO_FILTERS,
  currentStageId,
  findCachedLead,
  readCollapsed,
  stageLabel,
  useCachedLead,
  writeCollapsed,
  type LeadFilters,
} from './lead-board-utils';
import { LeadColumn } from './lead-column';
import { useLeadMove } from './lead-move';
import { LeadPanel } from './lead-panel';
import { FilterChips, FiltersMenu } from './leads-filters';
import { LeadsList } from './leads-list';

const MOBILE_BREAKPOINT = 768;

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}

function toggleClass(selected: boolean): string {
  return `min-h-9 rounded-lg px-3 text-sm font-medium transition-colors ${
    selected
      ? 'bg-primary text-white'
      : 'text-muted hover:bg-surface-2 hover:text-fg'
  }`;
}

/** The sales funnel: a Kanban to scan and move leads (ADR 058, UX standard).
 * Editing happens in the lead panel; the board has no inline controls. */
export function LeadsBoard(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const { operator } = useShell();
  const queryClient = useQueryClient();
  const toast = useToast();
  const isMobile = useIsMobile();
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
  const [filters, setFilters] = useState<LeadFilters>(NO_FILTERS);

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

  const [view, setView] = useState<'board' | 'list'>('board');
  const [mobileStageId, setMobileStageId] = useState<string | null>(null);
  const [funnelOpen, setFunnelOpen] = useState<boolean | null>(null);
  const showFunnel = funnelOpen ?? !isMobile;

  // WON and LOST columns collapse; the choice is remembered per user.
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setCollapsedMap(readCollapsed(operator.id));
  }, [operator.id]);
  function isCollapsed(stage: BoardStageView): boolean {
    if (stage.kind === 'OPEN') return false;
    return collapsedMap[stage.id] ?? isMobile;
  }
  function toggleCollapsed(stage: BoardStageView): void {
    const next = { ...collapsedMap, [stage.id]: !isCollapsed(stage) };
    setCollapsedMap(next);
    writeCollapsed(operator.id, next);
  }

  // Drag-and-drop state. `draggedId` is the lead being moved;
  // `draggedToStageId` is the column the drop would target.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [draggedToStageId, setDraggedToStageId] = useState<string | null>(null);
  const [dragStatus, setDragStatus] = useState('');

  // Moving into a LOST stage asks for the reason first.
  const [lost, setLost] = useState<{
    leadId: string;
    fromStageId: string;
    toStageId: string;
  } | null>(null);
  const [lostReasonDraft, setLostReasonDraft] = useState('');
  const move = useLeadMove();

  function requestMove(item: LeadPipelineItem, toStageId: string): void {
    const from = currentStageId(item, columns);
    if (from === toStageId) return;
    const target = columns.find((s) => s.id === toStageId);
    if (target?.kind === 'LOST') {
      setLostReasonDraft('');
      setLost({ leadId: item.id, fromStageId: from, toStageId });
      return;
    }
    move.mutate({ leadId: item.id, fromStageId: from, toStageId });
  }

  // The lead panel: the live copy of the lead comes from the query cache.
  const [openItem, setOpenItem] = useState<LeadPipelineItem | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const liveItem = useCachedLead(openItem?.id ?? null, openItem);
  function openLead(item: LeadPipelineItem, from: HTMLElement | null): void {
    setOpener(from);
    setOpenItem(item);
  }

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
    const item = draggedId ? findCachedLead(queryClient, draggedId) : undefined;
    setDraggedId(null);
    setDraggedToStageId(null);
    if (!item) return;
    const target = columns.find((s) => s.id === targetStageId);
    requestMove(item, targetStageId);
    setDragStatus(
      t(
        target?.kind === 'LOST' ? 'leads.dragDroppedLost' : 'leads.dragDropped',
      ),
    );
  }

  const switcher =
    list.length > 1 ? (
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
            className={`${toggleClass(pipeline.id === active?.id)} max-w-[14rem] truncate`}
          >
            {pipeline.name ?? t('pipeline.defaultName')}
          </button>
        ))}
      </div>
    ) : null;

  const visibleColumns =
    view === 'board'
      ? columns.filter(
          (stage) =>
            !isMobile || mobileStageId === null || stage.id === mobileStageId,
        )
      : columns;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3 sm:p-4">
      <div aria-live="polite" data-testid="leads-live" className="sr-only">
        {dragStatus}
      </div>
      <div
        data-testid="leads-toolbar"
        className="flex min-w-0 flex-wrap items-center gap-2"
      >
        {switcher}
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
            className={toggleClass(view === 'board')}
          >
            {t('leads.view.board')}
          </button>
          <button
            type="button"
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
            className={toggleClass(view === 'list')}
          >
            {t('leads.view.list')}
          </button>
        </div>
        <FiltersMenu
          filters={filters}
          onChange={setFilters}
          isMobile={isMobile}
        />
        {canExport ? (
          <Button
            size="sm"
            variant="secondary"
            loading={exporting}
            data-testid="leads-export"
            className="ml-auto min-w-0 max-w-full"
            onClick={() => {
              const qs = new URLSearchParams();
              if (filters.tagId) qs.set('tagId', filters.tagId);
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
      <FilterChips filters={filters} onChange={setFilters} />
      {board.isSuccess && columns.length > 0 && (
        <section
          aria-label={t('leads.funnelTitle')}
          className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-2"
        >
          <button
            type="button"
            data-testid="funnel-toggle"
            aria-expanded={showFunnel}
            onClick={() => setFunnelOpen(!showFunnel)}
            className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm font-semibold hover:bg-surface-2"
          >
            <span aria-hidden="true" className={showFunnel ? '' : '-rotate-90'}>
              ▾
            </span>
            {t('leads.funnelTitle')}
          </button>
          {showFunnel ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-2 pb-1">
              <div className="flex min-w-0 flex-wrap gap-2">
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className={`${fieldClass} min-h-9 w-40! min-w-0 max-w-full`}
                  aria-label={t('leads.funnelFrom')}
                />
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className={`${fieldClass} min-h-9 w-40! min-w-0 max-w-full`}
                  aria-label={t('leads.funnelTo')}
                />
              </div>
              <div className="flex min-w-0 flex-wrap gap-1">
                {columns.map((stage) => {
                  const total = columns.reduce((sum, s) => sum + s.count, 0);
                  const share =
                    total === 0 ? 0 : Math.round((stage.count / total) * 100);
                  const selected = mobileStageId === stage.id;
                  return (
                    <button
                      type="button"
                      key={stage.id}
                      onClick={() =>
                        setMobileStageId(selected ? null : stage.id)
                      }
                      className={`flex min-w-0 items-baseline gap-1.5 rounded-lg px-2 py-1 text-xs ${selected ? 'bg-primary-soft text-primary-fg' : 'bg-surface-2'}`}
                      data-testid="funnel-stage"
                      aria-pressed={selected}
                    >
                      <span className="truncate" title={stageLabel(stage, t)}>
                        {stageLabel(stage, t)}
                      </span>
                      <span className="font-semibold">{stage.count}</span>
                      <span className="text-muted">{share}%</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>
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
      {board.isSuccess && columns.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
          {t('leads.empty')}
        </p>
      ) : null}
      {board.isSuccess && columns.length > 0 && view === 'list' ? (
        <LeadsList
          pipelineId={active!.id}
          stages={columns}
          filters={filters}
          onOpen={openLead}
        />
      ) : null}
      {board.isSuccess && columns.length > 0 && view === 'board' ? (
        <div
          aria-label={t('leads.columns')}
          className="relative flex min-h-0 min-w-0 max-w-full items-start gap-3 overflow-x-auto pb-2"
        >
          {isMobile && mobileStageId === null ? (
            <p className="sr-only">{t('leads.pickStage')}</p>
          ) : null}
          {visibleColumns.map((stage) => (
            <LeadColumn
              key={stage.id}
              stage={stage}
              pipelineId={active!.id}
              stages={columns}
              filters={filters}
              collapsed={isCollapsed(stage)}
              onToggleCollapsed={() => toggleCollapsed(stage)}
              draggedId={draggedId}
              draggedToStageId={draggedToStageId}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOverStage={(id) => setDraggedToStageId(id)}
              onDragLeaveStage={() => setDraggedToStageId(null)}
              onDrop={handleDrop}
              onOpen={openLead}
              onRequestMove={requestMove}
              onAnnounce={setDragStatus}
            />
          ))}
        </div>
      ) : null}

      <LeadPanel
        item={openItem ? liveItem : null}
        stages={columns}
        opener={opener}
        onClose={() => setOpenItem(null)}
        onRequestMove={requestMove}
      />

      <FormDialog
        open={lost !== null}
        title={t('opportunity.lostReason')}
        description={t('opportunity.lostReasonBody')}
        testId="lead-lost-dialog"
        onClose={() => setLost(null)}
        onSubmit={() => {
          const reason = lostReasonDraft.trim();
          if (!reason || !lost) return;
          move.mutate({ ...lost, lostReason: reason });
          setLost(null);
        }}
        footer={
          <>
            <Button variant="secondary" onClick={() => setLost(null)}>
              {t('app.cancel')}
            </Button>
            <Button type="submit" variant="primary">
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
