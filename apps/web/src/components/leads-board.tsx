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
import { channelName } from '@/lib/channel-names';
import type {
  ConversationState,
  LeadPipelineItem,
  LeadPipelinePage,
  LeadScore,
  LeadStage,
  LeadStatus,
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

function stageName(stage: LeadStage, t: (key: string) => string): string {
  return stage.name ?? (stage.code ? t(`leads.stage.${stage.code}`) : '');
}

/** Tenant-configured funnels; lead score remains a separate attribute.
 * ADR 057: every pipeline has its own stages, and the board shows one
 * pipeline at a time. */
export function LeadsBoard(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { operator } = useShell();
  const canManage = operator.role === 'OWNER' || operator.role === 'ADMIN';

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
  }, [list, urlPipeline]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = list.find((p) => p.id === activeId) ?? list[0];
  const stages = useQuery({
    queryKey: ['lead-stages', active?.id],
    enabled: !!active,
    queryFn: () =>
      api<LeadStage[]>(`/api/v1/leads/stages?pipelineId=${active!.id}`),
  });

  const [ownerId, setOwnerId] = useState('');
  const [source, setSource] = useState('');
  const [closeBefore, setCloseBefore] = useState('');
  const [closeAfter, setCloseAfter] = useState('');
  const [tagId, setTagId] = useState('');
  const [score, setScore] = useState('');
  const filters: LeadFilters = { ownerId, source, closeBefore, closeAfter, tagId, score };

  function choose(next: PipelineView): void {
    setActiveId(next.id);
    router.replace(`/leads?view=funnel&pipeline=${next.id}`, { scroll: false });
  }

  const rows = stages.data ?? [];
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
      </div>
      <LeadsFilters
        filters={filters}
        onChange={(next) => {
          setOwnerId(next.ownerId);
          setSource(next.source);
          setCloseBefore(next.closeBefore);
          setCloseAfter(next.closeAfter);
          setTagId(next.tagId);
          setScore(next.score);
        }}
        onClear={() => {
          setOwnerId('');
          setSource('');
          setCloseBefore('');
          setCloseAfter('');
          setTagId('');
          setScore('');
        }}
      />
      {stages.isPending ? (
        <div role="status">
          <span className="sr-only">{t('app.loading')}</span>
          <SkeletonRows rows={3} />
        </div>
      ) : null}
      {stages.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" />
            {t(errorKey(stages.error))}
          </p>
          <Button size="sm" onClick={() => void stages.refetch()}>
            {t('app.retry')}
          </Button>
        </div>
      ) : null}
      {stages.isSuccess && rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
          {t('leads.empty')}
        </p>
      ) : null}
      {stages.isSuccess && rows.length > 0 ? (
        <div
          aria-label={t('leads.columns')}
          className="relative flex min-h-0 min-w-0 max-w-full flex-1 items-stretch gap-3 overflow-x-auto pb-2"
        >
          {rows.map((stage) => (
            <LeadColumn
              key={stage.id}
              stage={stage}
              pipelineId={active!.id}
              stages={rows}
              filters={filters}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LeadColumn(props: {
  stage: LeadStage;
  pipelineId: string;
  stages: LeadStage[];
  filters: LeadFilters;
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
      if (props.filters.score) params.set('score', props.filters.score);
      return api<LeadPipelinePage>(`/api/v1/leads?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const count = query.hasNextPage ? `${items.length}+` : String(items.length);
  const name = stageName(props.stage, t);

  return (
    <section
      aria-label={name}
      data-testid={`lead-column-${props.stage.code ?? props.stage.id}`}
      className="flex w-[min(85vw,21rem)] min-w-[min(85vw,21rem)] shrink-0 flex-col rounded-2xl border border-line bg-surface shadow-card md:w-80 md:min-w-80"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="min-w-0 truncate font-semibold">{name}</h2>
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
  stages: LeadStage[];
  pipelineId: string;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { timeZone, operator } = useShell();
  const queryClient = useQueryClient();
  const canEdit = ['OWNER', 'ADMIN', 'OPERATOR'].includes(operator.role);
  // Optimistic selections: keep the user's choice visible while a mutation is
  // in flight or before the invalidated query refetch reflects it, so a
  // background refetch cannot snap the controlled select back to stale data.
  const [stageChoice, setStageChoice] = useState<string | null>(null);
  const [scoreChoice, setScoreChoice] = useState<LeadScore | null>(null);
  const [statusChoice, setStatusChoice] = useState<LeadStatus | null>(null);

  useEffect(() => {
    if (stageChoice && props.currentStageId === stageChoice) {
      setStageChoice(null);
    }
  }, [props.currentStageId, stageChoice]);
  useEffect(() => {
    if (scoreChoice && props.item.score === scoreChoice) {
      setScoreChoice(null);
    }
  }, [props.item.score, scoreChoice]);
  useEffect(() => {
    if (statusChoice && props.item.status === statusChoice) {
      setStatusChoice(null);
    }
  }, [props.item.status, statusChoice]);

  // Operator-set score and status (ADR 037) stay next to the funnel stage.
  const [lostDialog, setLostDialog] = useState(false);
  const [lostReasonDraft, setLostReasonDraft] = useState('');
  const setField = useMutation({
    mutationFn: (input: {
      field: 'score' | 'status';
      value: string;
      lostReason?: string;
    }) =>
      api(
        `/api/v1/leads/conversations/${props.item.conversation.id}/${input.field}`,
        {
          method: 'PUT',
          body:
            input.field === 'score'
              ? { score: input.value === 'AUTO' ? null : input.value }
              : input.lostReason !== undefined
                ? { status: input.value, lostReason: input.lostReason }
                : { status: input.value },
        },
      ),
    onSettled: (_data, _error, input) => {
      // The optimistic choice ends once the refetch has the server's answer,
      // so a change made by another operator in the meantime is not hidden.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leads'] }),
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
      ]).finally(() => {
        if (input.field === 'score') setScoreChoice(null);
        else setStatusChoice(null);
      });
    },
    onError: (_error, input) => {
      if (input.field === 'score') setScoreChoice(null);
      if (input.field === 'status') setStatusChoice(null);
    },
  });
  const move = useMutation({
    mutationFn: (stageId: string) =>
      api(`/api/v1/leads/${props.item.id}/stage`, {
        method: 'PATCH',
        body: { stageId },
      }),
    onSettled: () => {
      void queryClient
        .invalidateQueries({ queryKey: ['leads'] })
        .finally(() => setStageChoice(null));
    },
    onError: () => setStageChoice(null),
  });
  const name = props.item.contact.name ?? t('list.unnamed');
  const stageValue = stageChoice ?? props.currentStageId;
  const scoreValue = scoreChoice ?? props.item.score;
  const statusValue = statusChoice ?? props.item.status;

  return (
    <li>
      <article
        data-testid="lead-card"
        className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-canvas p-3"
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
              <Badge tone={SCORE_TONE[scoreValue]} dot>
                {t(`score.${scoreValue}`)}
              </Badge>
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
          <LeadOpportunity
            leadId={props.item.id}
            item={props.item}
            stages={props.stages}
            pipelineId={props.pipelineId}
          />
        ) : null}
        {canEdit ? (
          <label className="flex flex-col gap-1 text-xs text-muted">
            {t('leads.moveToStage')}
            <select
              aria-label={t('leads.moveToStage')}
              data-testid="lead-card-stage"
              value={stageValue}
              disabled={move.isPending}
              onChange={(event) => {
                const value = event.target.value;
                setStageChoice(value);
                move.mutate(value);
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
        {canEdit ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
              {t('leads.view.score')}
              <select
                aria-label={t('leads.view.score')}
                data-testid="lead-card-score"
                value={scoreValue}
                disabled={setField.isPending}
                onChange={(event) => {
                  const value = event.target.value as LeadScore;
                  setScoreChoice(value);
                  setField.mutate({ field: 'score', value });
                }}
                className="min-h-9 rounded-lg border border-line bg-surface px-2 text-sm text-fg"
              >
                {(
                  [
                    'HOT',
                    'WARM',
                    'COLD',
                  ] as const satisfies readonly LeadScore[]
                ).map((score) => (
                  <option key={score} value={score}>
                    {t(`score.${score}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
              {t('leads.view.status')}
              <select
                aria-label={t('leads.view.status')}
                data-testid="lead-card-status"
                value={statusValue}
                disabled={setField.isPending}
                onChange={(event) => {
                  const value = event.target.value as LeadStatus;
                  if (value === 'LOST' && statusValue !== 'LOST') {
                    setLostReasonDraft('');
                    setLostDialog(true);
                    return;
                  }
                  setStatusChoice(value);
                  setField.mutate({ field: 'status', value });
                }}
                className="min-h-9 rounded-lg border border-line bg-surface px-2 text-sm text-fg"
              >
                {(
                  [
                    'NEW',
                    'IN_PROGRESS',
                    'WON',
                    'LOST',
                  ] as const satisfies readonly LeadStatus[]
                ).map((status) => (
                  <option key={status} value={status}>
                    {t(`leadStatus.${status}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {setField.isError ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(setField.error))}
          </p>
        ) : null}
        {move.isError ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(move.error))}
          </p>
        ) : null}
        <FormDialog
          open={lostDialog}
          title={t('opportunity.lostReason')}
          description={t('opportunity.lostReasonBody')}
          testId="lead-lost-dialog"
          onClose={() => setLostDialog(false)}
          onSubmit={() => {
            const reason = lostReasonDraft.trim();
            if (!reason) return;
            setStatusChoice('LOST');
            setField.mutate(
              { field: 'status', value: 'LOST', lostReason: reason },
              { onSuccess: () => setLostDialog(false) },
            );
          }}
          footer={
            <>
              <Button variant="secondary" onClick={() => setLostDialog(false)}>
                {t('app.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={setField.isPending}
              >
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
  score: string;
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
