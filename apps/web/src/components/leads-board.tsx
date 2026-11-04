'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type DragEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type {
  ConversationListItem,
  ConversationPage,
  ConversationState,
  LeadScore,
  LeadStatus,
} from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { Icon } from './ui/icons';
import { Select } from './ui/select';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

/** Two boards over the same leads (ADR 037): by score or by status. */
type Mode = 'score' | 'status';
type Column = LeadScore | LeadStatus;

const COLUMNS: Record<Mode, readonly Column[]> = {
  score: ['HOT', 'WARM', 'COLD'],
  status: ['NEW', 'IN_PROGRESS', 'WON', 'LOST'],
};
const STATE_TONE: Record<ConversationState, Tone> = {
  BOT_ACTIVE: 'neutral',
  WAITING_OPERATOR: 'warning',
  OPERATOR_ACTIVE: 'accent',
  CLOSED: 'neutral',
};
const COLUMN_TONE: Record<Column, Tone> = {
  HOT: 'danger',
  WARM: 'warning',
  COLD: 'neutral',
  NEW: 'neutral',
  IN_PROGRESS: 'accent',
  WON: 'success',
  LOST: 'danger',
};
const DRAG_TYPE = 'application/x-tezda-lead';

function label(mode: Mode, column: Column): string {
  return mode === 'score' ? `score.${column}` : `leadStatus.${column}`;
}

/** Hot / Warm / Cold or New ... Lost columns; a card moves by drag or menu. */
export function LeadsBoard(): ReactNode {
  const { t } = useI18n();
  const { timeZone, operator } = useShell();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canMove = ['OWNER', 'ADMIN', 'OPERATOR'].includes(operator.role);
  const [mode, setMode] = useState<Mode>('score');
  const [active, setActive] = useState<Column>('HOT');
  const [error, setError] = useState<string | undefined>();
  const move = useMutation({
    mutationFn: (input: { conversationId: string; to: Column }) =>
      api(`/api/v1/leads/conversations/${input.conversationId}/${mode}`, {
        method: 'PUT',
        body: mode === 'score' ? { score: input.to } : { status: input.to },
      }),
    onMutate: () => setError(undefined),
    onError: (failure) => setError(errorKey(failure)),
    onSuccess: () => toast(t('leads.moved')),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const columns = COLUMNS[mode];

  function switchMode(next: Mode): void {
    setMode(next);
    setActive(COLUMNS[next][0]!);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{t('leads.intro')}</p>
        <div
          role="radiogroup"
          aria-label={t('leads.view')}
          className="flex gap-1 rounded-xl bg-surface-2 p-1"
        >
          {(['score', 'status'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              data-testid={`leads-mode-${value}`}
              onClick={() => switchMode(value)}
              className={`min-h-9 rounded-lg px-3 text-sm font-medium transition-colors ${
                mode === value
                  ? 'bg-surface text-fg shadow-card'
                  : 'text-muted hover:text-fg'
              }`}
            >
              {t(`leads.view.${value}`)}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" />
          {t(error)}
        </p>
      ) : null}
      <div
        role="tablist"
        aria-label={t('leads.columns')}
        className="flex gap-1 rounded-xl bg-surface-2 p-1 md:hidden"
      >
        {columns.map((column) => (
          <button
            key={column}
            type="button"
            role="tab"
            aria-selected={active === column}
            onClick={() => setActive(column)}
            className={`min-h-9 flex-1 rounded-lg px-2 text-sm font-medium transition-colors ${
              active === column
                ? 'bg-surface text-fg shadow-card'
                : 'text-muted hover:text-fg'
            }`}
          >
            {t(label(mode, column))}
          </button>
        ))}
      </div>
      <div
        className={`grid min-h-0 flex-1 grid-cols-1 gap-3 ${
          mode === 'score' ? 'md:grid-cols-3' : 'md:grid-cols-4'
        }`}
      >
        {columns.map((column) => (
          <LeadColumn
            key={`${mode}-${column}`}
            mode={mode}
            column={column}
            columns={columns}
            timeZone={timeZone}
            canMove={canMove}
            busy={move.isPending}
            onMove={(conversationId, to) => move.mutate({ conversationId, to })}
            className={active === column ? 'flex' : 'hidden md:flex'}
          />
        ))}
      </div>
    </div>
  );
}

function LeadColumn(props: {
  mode: Mode;
  column: Column;
  columns: readonly Column[];
  className: string;
  timeZone: string | undefined;
  canMove: boolean;
  busy: boolean;
  onMove: (conversationId: string, to: Column) => void;
}): ReactNode {
  const { t } = useI18n();
  const now = useNow();
  const [over, setOver] = useState(false);
  const filter = props.mode === 'score' ? 'leadScore' : 'leadStatus';
  const query = useInfiniteQuery({
    queryKey: ['conversations', 'leads', props.mode, props.column],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        scope: 'all',
        limit: '25',
        [filter]: props.column,
      });
      if (pageParam) params.set('cursor', pageParam);
      return api<ConversationPage>(
        `/api/v1/inbox/conversations?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const count = query.hasNextPage ? `${items.length}+` : String(items.length);

  function drop(event: DragEvent): void {
    setOver(false);
    const conversationId = event.dataTransfer.getData(DRAG_TYPE);
    if (!conversationId || !props.canMove) return;
    event.preventDefault();
    if (items.some((item) => item.id === conversationId)) return;
    props.onMove(conversationId, props.column);
  }

  return (
    <section
      aria-label={t(label(props.mode, props.column))}
      data-testid={`lead-column-${props.column}`}
      onDragOver={(event) => {
        if (!props.canMove) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={`${props.className} min-h-0 min-w-0 flex-col rounded-2xl border bg-surface shadow-card transition-colors ${
        over ? 'border-primary bg-primary-soft' : 'border-line'
      }`}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 font-semibold">
          <Badge tone={COLUMN_TONE[props.column]} dot>
            {t(label(props.mode, props.column))}
          </Badge>
        </h2>
        {query.isSuccess ? (
          <span
            data-testid="lead-count"
            className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted"
          >
            {count}
          </span>
        ) : null}
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
          <li className="flex flex-col items-center gap-3 px-4 py-10 text-center text-muted">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2">
              <Icon name="users" className="h-6 w-6" />
            </span>
            <p>{t('leads.empty')}</p>
          </li>
        ) : null}
        {items.map((item) => (
          <LeadCard
            key={item.id}
            item={item}
            now={now}
            timeZone={props.timeZone}
            mode={props.mode}
            current={props.column}
            columns={props.columns}
            canMove={props.canMove}
            busy={props.busy}
            onMove={props.onMove}
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
  item: ConversationListItem;
  now: number;
  timeZone: string | undefined;
  mode: Mode;
  current: Column;
  columns: readonly Column[];
  canMove: boolean;
  busy: boolean;
  onMove: (conversationId: string, to: Column) => void;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { item, now } = props;
  const overdue = item.slaDueAt ? Date.parse(item.slaDueAt) < now : false;
  const other = props.mode === 'score' ? item.leadStatus : item.leadScore;
  return (
    <li
      draggable={props.canMove}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, item.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      data-testid="lead-card-item"
      className="flex flex-col gap-2 rounded-xl border border-line bg-canvas p-3"
    >
      <Link
        href={`/inbox?scope=all&c=${item.id}`}
        data-testid="lead-card"
        draggable={false}
        className="flex min-w-0 items-start gap-3 rounded-lg transition-colors hover:text-primary"
      >
        <Avatar name={item.contactName} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* Customer-provided name: text only. */}
          <span className="truncate font-medium">
            {item.contactName ?? t('list.unnamed')}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATE_TONE[item.state]} dot>
              {t(`state.${item.state}`)}
            </Badge>
            {other ? (
              <Badge tone={COLUMN_TONE[other]}>
                {t(
                  props.mode === 'score'
                    ? `leadStatus.${other}`
                    : `score.${other}`,
                )}
              </Badge>
            ) : null}
            {props.mode === 'score' && item.leadScoreSetByOperator ? (
              <Badge>{t('view.scoreByOperator')}</Badge>
            ) : null}
            {item.language ? (
              <Badge className="uppercase">{item.language}</Badge>
            ) : null}
            {overdue ? (
              <Badge tone="danger">
                <Icon name="clock" className="h-3 w-3" />
                {t('list.sla')}
              </Badge>
            ) : null}
          </span>
          <span className="text-xs text-muted">
            {t('leads.updated', {
              date: formatDateTime(item.updatedAt, props.timeZone),
            })}
          </span>
        </span>
      </Link>
      {props.canMove ? (
        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="shrink-0">{t('leads.moveTo')}</span>
          <Select
            value={props.current}
            disabled={props.busy}
            data-testid="lead-move"
            onChange={(event) => {
              const to = event.target.value as Column;
              if (to !== props.current) props.onMove(item.id, to);
            }}
          >
            {props.columns.map((column) => (
              <option key={column} value={column}>
                {t(label(props.mode, column))}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
    </li>
  );
}
