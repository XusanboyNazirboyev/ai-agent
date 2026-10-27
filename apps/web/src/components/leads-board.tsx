'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type {
  ConversationListItem,
  ConversationPage,
  ConversationState,
  LeadScore,
} from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

const SCORES: LeadScore[] = ['HOT', 'WARM', 'COLD'];

const STATE_TONE: Record<ConversationState, Tone> = {
  BOT_ACTIVE: 'neutral',
  WAITING_OPERATOR: 'warning',
  OPERATOR_ACTIVE: 'accent',
  CLOSED: 'neutral',
};
const SCORE_TONE: Record<LeadScore, Tone> = {
  HOT: 'danger',
  WARM: 'warning',
  COLD: 'neutral',
};

/** Hot / Warm / Cold columns (a pipeline view) over the inbox list API. */
export function LeadsBoard(): ReactNode {
  const { t } = useI18n();
  const { timeZone } = useShell();
  const [active, setActive] = useState<LeadScore>('HOT');
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
      <p className="text-sm text-muted">{t('leads.intro')}</p>
      <div
        role="tablist"
        aria-label={t('leads.columns')}
        className="flex gap-1 rounded-xl bg-surface-2 p-1 md:hidden"
      >
        {SCORES.map((score) => (
          <button
            key={score}
            type="button"
            role="tab"
            aria-selected={active === score}
            onClick={() => setActive(score)}
            className={`min-h-9 flex-1 rounded-lg px-2 text-sm font-medium transition-colors ${
              active === score
                ? 'bg-surface text-fg shadow-card'
                : 'text-muted hover:text-fg'
            }`}
          >
            {t(`score.${score}`)}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-3">
        {SCORES.map((score) => (
          <LeadColumn
            key={score}
            score={score}
            timeZone={timeZone}
            className={active === score ? 'flex' : 'hidden md:flex'}
          />
        ))}
      </div>
    </div>
  );
}

function LeadColumn(props: {
  score: LeadScore;
  className: string;
  timeZone: string | undefined;
}): ReactNode {
  const { t } = useI18n();
  const { timeZone } = props;
  const now = useNow();
  const query = useInfiniteQuery({
    queryKey: ['conversations', 'leads', props.score],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        scope: 'all',
        limit: '25',
        leadScore: props.score,
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

  return (
    <section
      aria-label={t(`score.${props.score}`)}
      data-testid={`lead-column-${props.score}`}
      className={`${props.className} min-h-0 min-w-0 flex-col rounded-2xl border border-line bg-surface shadow-card`}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 font-semibold">
          <Badge tone={SCORE_TONE[props.score]} dot>
            {t(`score.${props.score}`)}
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
          <LeadCard key={item.id} item={item} now={now} timeZone={timeZone} />
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
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { item, now } = props;
  const overdue = item.slaDueAt ? Date.parse(item.slaDueAt) < now : false;
  return (
    <li>
      <Link
        href={`/inbox?scope=all&c=${item.id}`}
        data-testid="lead-card"
        className="flex min-w-0 items-start gap-3 rounded-xl border border-line bg-canvas p-3 transition-colors hover:border-primary hover:bg-primary-soft"
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
    </li>
  );
}
