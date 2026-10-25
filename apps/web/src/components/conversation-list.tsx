'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { isUnread } from '@/lib/seen';
import type {
  ConversationListItem,
  ConversationPage,
  ConversationState,
  LeadScore,
  Scope,
} from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { Avatar } from './ui/avatar';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Select } from './ui/select';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

const SCOPES: Scope[] = ['waiting', 'mine', 'all', 'closed'];
const LANGUAGES = ['uz', 'ru', 'en'];
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

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return (): void => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function ConversationList(props: {
  scope: Scope;
  selectedId: string | null;
  timeZone?: string;
  waitingCount: number;
  onScope: (scope: Scope) => void;
  onSelect: (id: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('');
  const [score, setScore] = useState('');
  const q = useDebounced(search.trim(), 300);
  const now = useNow();
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});

  const query = useInfiniteQuery({
    queryKey: ['conversations', props.scope, q, language, score],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ scope: props.scope, limit: '25' });
      if (pageParam) params.set('cursor', pageParam);
      if (q) params.set('q', q);
      if (language) params.set('language', language);
      if (score) params.set('leadScore', score);
      return api<ConversationPage>(
        `/api/v1/inbox/conversations?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(q || language || score);

  function onTabKey(event: KeyboardEvent, index: number): void {
    const last = SCOPES.length - 1;
    const target =
      event.key === 'ArrowRight'
        ? (index + 1) % SCOPES.length
        : event.key === 'ArrowLeft'
          ? (index + last) % SCOPES.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (target < 0) return;
    event.preventDefault();
    props.onScope(SCOPES[target]);
    tabs.current[SCOPES[target]]?.focus();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label={t('list.scopes')}
        className="m-3 mb-0 flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1"
      >
        {SCOPES.map((scope, index) => {
          const active = props.scope === scope;
          return (
            <button
              key={scope}
              ref={(node) => {
                tabs.current[scope] = node;
              }}
              role="tab"
              type="button"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => props.onScope(scope)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={`flex min-h-9 flex-auto items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                active
                  ? 'bg-surface text-fg shadow-card'
                  : 'text-muted hover:text-fg'
              }`}
            >
              {t(`scope.${scope}`)}
              {scope === 'waiting' && props.waitingCount > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-xs leading-5 text-white">
                  {props.waitingCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            <Icon name="search" />
          </span>
          <input
            type="search"
            aria-label={t('list.search')}
            placeholder={t('list.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClass} pl-9`}
          />
        </div>
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
            {t('list.filterLanguage')}
            <Select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="">{t('list.any')}</option>
              {LANGUAGES.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
            {t('list.filterScore')}
            <Select value={score} onChange={(e) => setScore(e.target.value)}>
              <option value="">{t('list.any')}</option>
              {SCORES.map((id) => (
                <option key={id} value={id}>
                  {t(`score.${id}`)}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
      <ul
        className="min-h-0 flex-1 overflow-y-auto border-t border-line"
        data-testid="conversation-list"
      >
        {query.isPending ? (
          <li role="status">
            <span className="sr-only">{t('app.loading')}</span>
            <SkeletonRows rows={5} />
          </li>
        ) : null}
        {query.isError ? (
          <li className="flex flex-col items-start gap-3 p-4">
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
          <li className="flex flex-col items-center gap-3 px-6 py-12 text-center text-muted">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2">
              <Icon name={filtered ? 'search' : 'inbox'} className="h-6 w-6" />
            </span>
            <p>{filtered ? t('list.emptyFiltered') : t('list.empty')}</p>
          </li>
        ) : null}
        {items.map((item) => (
          <ConversationRow
            key={item.id}
            item={item}
            now={now}
            selected={props.selectedId === item.id}
            onSelect={props.onSelect}
          />
        ))}
        {query.hasNextPage ? (
          <li className="p-3">
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
    </div>
  );
}

function ConversationRow(props: {
  item: ConversationListItem;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const { item, now } = props;
  const minutes = item.waitingSince
    ? Math.max(0, Math.floor((now - Date.parse(item.waitingSince)) / 60_000))
    : null;
  const overdue = item.slaDueAt ? Date.parse(item.slaDueAt) < now : false;
  const unread = !props.selected && isUnread(item.id, item.updatedAt);
  return (
    <li>
      <button
        type="button"
        data-testid="conversation-item"
        data-id={item.id}
        aria-current={props.selected}
        onClick={() => props.onSelect(item.id)}
        className={`flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors hover:bg-surface-2 ${
          props.selected ? 'bg-primary-soft hover:bg-primary-soft' : ''
        }`}
      >
        <Avatar name={item.contactName} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-center justify-between gap-2">
            {/* Customer-provided name: text only. */}
            <span className="truncate font-medium">
              {item.contactName ?? t('list.unnamed')}
            </span>
            {unread ? (
              <span
                role="img"
                aria-label={t('list.unread')}
                title={t('list.unread')}
                className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATE_TONE[item.state]} dot>
              {t(`state.${item.state}`)}
            </Badge>
            {item.leadScore ? (
              <Badge tone={SCORE_TONE[item.leadScore]}>
                {t(`score.${item.leadScore}`)}
              </Badge>
            ) : null}
            {overdue ? (
              <Badge tone="danger">
                <Icon name="clock" className="h-3 w-3" />
                {t('list.sla')}
              </Badge>
            ) : null}
          </span>
          {minutes !== null && item.state === 'WAITING_OPERATOR' ? (
            <span className="text-xs text-muted">
              {t('list.waitingFor', { minutes })}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
