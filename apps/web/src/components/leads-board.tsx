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
import { AddLeadDialog } from './add-lead-dialog';
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
  const canAdd = operator.role !== 'VIEWER';
  // The add-lead dialog: open flag and the stage to preselect (column "+").
  const [adding, setAdding] = useState<{ stageId: string | null } | null>(null);

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

  const [filters, setFilters] = useState<LeadFilters>(NO_FILTERS);
  const fromDate = filters.createdFrom;
  const toDate = filters.createdTo;

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
    return !isMobile && (collapsedMap[stage.id] ?? false);
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
    if (currentStageId(item, columns) === targetStageId) return;
    requestMove(item, targetStageId);
    setDragStatus(
      t(
        target?.kind === 'LOST' ? 'leads.dragDroppedLost' : 'leads.dragDropped',
      ),
    );
  }

  /** Mobile swipe: the next stage to the right, the previous to the left. */
  function handleSwipe(
    item: LeadPipelineItem,
    direction: 'next' | 'prev',
  ): void {
    const index = columns.findIndex(
      (s) => s.id === currentStageId(item, columns),
    );
    const target = columns[index + (direction === 'next' ? 1 : -1)];
    if (!target) return;
    requestMove(item, target.id);
    setDragStatus(
      target.kind === 'LOST'
        ? t('leads.dragDroppedLost')
        : t('leads.movedTo', { stage: stageLabel(target, t) }),
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

  // Below md the board shows one stage at a time, picked from the tab bar.
  const selectedStageId =
    columns.find((s) => s.id === mobileStageId)?.id ?? columns[0]?.id ?? null;
  const visibleColumns =
    view === 'board' && isMobile
      ? columns.filter((stage) => stage.id === selectedStageId)
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
            {t('leads.view.table')}
          </button>
        </div>
        <FiltersMenu
          filters={filters}
          onChange={setFilters}
          isMobile={isMobile}
        />
        {canAdd ? (
          <Button
            size="sm"
            variant="primary"
            icon="plus"
            data-testid="lead-add"
            className="ml-auto min-w-0 max-w-full"
            onClick={() => setAdding({ stageId: null })}
          >
            {t('leads.add')}
          </Button>
        ) : null}
        {canExport ? (
          <Button
            size="sm"
            variant="secondary"
            loading={exporting}
            data-testid="leads-export"
            className={`min-w-0 max-w-full ${canAdd ? '' : 'ml-auto'}`}
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
            <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-1">
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
      {board.isSuccess && columns.length > 0 && view === 'board' && isMobile ? (
        <div
          role="group"
          aria-label={t('leads.stageTabs')}
          data-testid="leads-stage-tabs"
          className="flex min-w-0 gap-1 overflow-x-auto pb-1"
        >
          {columns.map((stage) => {
            const selected = stage.id === selectedStageId;
            const tone =
              stage.kind === 'WON'
                ? 'bg-success-soft text-success-fg'
                : stage.kind === 'LOST'
                  ? 'bg-danger-soft text-danger-fg'
                  : 'bg-surface text-fg';
            return (
              <button
                key={stage.id}
                type="button"
                data-testid="leads-stage-tab"
                aria-pressed={selected}
                onClick={() => setMobileStageId(stage.id)}
                className={`flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-sm font-medium ${tone} ${selected ? 'border-primary ring-2 ring-primary' : 'border-line'}`}
              >
                {stageLabel(stage, t)}
                <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted">
                  {stage.count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {board.isSuccess && columns.length > 0 && view === 'board' ? (
        <div
          aria-label={t('leads.columns')}
          data-testid="leads-board-scroller"
          className="relative flex min-h-0 min-w-0 max-w-full items-start gap-3 overflow-x-auto pb-2"
        >
          {visibleColumns.map((stage) => (
            <LeadColumn
              key={stage.id}
              stage={stage}
              pipelineId={active!.id}
              stages={columns}
              filters={filters}
              collapsed={isCollapsed(stage)}
              single={isMobile}
              onToggleCollapsed={() => toggleCollapsed(stage)}
              draggedId={draggedId}
              draggedToStageId={draggedToStageId}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={setDraggedToStageId}
              onSwipe={handleSwipe}
              onDrop={handleDrop}
              onOpen={openLead}
              onRequestMove={requestMove}
              onAnnounce={setDragStatus}
              onAdd={canAdd ? (id) => setAdding({ stageId: id }) : undefined}
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

      {/* Mounted only while open, so its fields are not on the page otherwise. */}
      {active && adding ? (
        <AddLeadDialog
          open
          pipelineId={active.id}
          stages={columns}
          stageId={adding?.stageId ?? mobileStageId}
          onClose={() => setAdding(null)}
        />
      ) : null}

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
