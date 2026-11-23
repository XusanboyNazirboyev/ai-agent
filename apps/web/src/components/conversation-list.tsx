'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { isStartCommand } from '@/lib/bot-command';
import { channelName } from '@/lib/channel-names';
import { api, errorKey } from '@/lib/api';
import { shortTime } from '@/lib/inbox-row';
import { isUnread } from '@/lib/seen';
import type {
  ChannelAccount,
  ConversationListItem,
  ConversationPage,
  LeadScore,
  Scope,
  TagRef,
} from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { Avatar } from './ui/avatar';
import { ChannelLogo } from './ui/channel-logo';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Select } from './ui/select';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

const SCOPES: Scope[] = ['all', 'waiting', 'closed'];
const LANGUAGES = ['uz', 'ru', 'en'];
const SCORES: LeadScore[] = ['HOT', 'WARM', 'COLD'];

const SCORE_TONE: Record<LeadScore, Tone> = {
  HOT: 'danger',
  WARM: 'warning',
  COLD: 'neutral',
};

interface ChannelFilter {
  type?: string;
  accountId?: string;
}

interface ChannelChip extends ChannelFilter {
  key: string;
  /** Undefined for "all chats" (translated). */
  label?: string;
}

const CHAT_CHANNELS = ['telegram', 'instagram', 'facebook'];

/**
 * "All", one chip per connected messenger, and one per account when a
 * messenger has several (owner 2026-11-23).
 */
export function chipsFor(accounts: readonly ChannelAccount[]): ChannelChip[] {
  const chips: ChannelChip[] = [{ key: 'all' }];
  for (const type of CHAT_CHANNELS) {
    const own = accounts.filter((account) => account.channelType === type);
    if (own.length === 0) continue;
    chips.push({ key: type, type, label: channelName(type) });
    if (own.length > 1)
      own.forEach((account, index) =>
        chips.push({
          key: account.id,
          type,
          accountId: account.id,
          label: account.displayName ?? `${channelName(type)} ${index + 1}`,
        }),
      );
  }
  return chips;
}

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
  const [tagId, setTagId] = useState('');
  // Owner 2026-11-23: all chats, one messenger, or one account of it.
  const [channel, setChannel] = useState<ChannelFilter>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const accounts = useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ items: ChannelAccount[] }>('/api/v1/channels'),
  });
  const channelChips = chipsFor(accounts.data?.items ?? []);
  const activeFilters = (language ? 1 : 0) + (score ? 1 : 0) + (tagId ? 1 : 0);
  const tagList = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ items: TagRef[] }>('/api/v1/tags'),
    enabled: filtersOpen || Boolean(tagId),
  });
  const q = useDebounced(search.trim(), 300);
  const now = useNow();
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});

  const query = useInfiniteQuery({
    queryKey: [
      'conversations',
      props.scope,
      q,
      language,
      score,
      tagId,
      channel.type ?? '',
      channel.accountId ?? '',
    ],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ scope: props.scope, limit: '25' });
      if (pageParam) params.set('cursor', pageParam);
      if (q) params.set('q', q);
      if (language) params.set('language', language);
      if (score) params.set('leadScore', score);
      if (tagId) params.set('tagId', tagId);
      if (channel.accountId) params.set('channelAccountId', channel.accountId);
      else if (channel.type) params.set('channelType', channel.type);
      return api<ConversationPage>(
        `/api/v1/inbox/conversations?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(
    q || language || score || tagId || channel.type || channel.accountId,
  );

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
        className="m-3 mb-0 flex gap-0.5 rounded-xl bg-surface-2 p-1"
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
              className={`flex min-h-9 min-w-0 flex-auto items-center justify-center gap-1 rounded-lg px-1.5 text-[0.8125rem] font-medium whitespace-nowrap transition-colors ${
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
      {channelChips.length > 2 ? (
        <div
          role="group"
          aria-label={t('list.channels')}
          data-testid="inbox-channels"
          className="mx-3 mt-3 flex gap-1.5 overflow-x-auto pb-1"
        >
          {channelChips.map((chip) => {
            const active =
              (chip.accountId ?? '') === (channel.accountId ?? '') &&
              (chip.type ?? '') === (channel.type ?? '');
            return (
              <button
                key={chip.key}
                type="button"
                aria-pressed={active}
                data-testid={`inbox-channel-${chip.key}`}
                onClick={() =>
                  setChannel({
                    ...(chip.type ? { type: chip.type } : {}),
                    ...(chip.accountId ? { accountId: chip.accountId } : {}),
                  })
                }
                className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap transition-colors ${
                  active
                    ? 'border-primary bg-primary-soft text-primary-fg'
                    : 'border-line bg-surface text-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                {chip.type ? (
                  <ChannelLogo channelType={chip.type} decorative />
                ) : null}
                {chip.label ?? t('list.channelAll')}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
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
          <button
            type="button"
            data-testid="inbox-filters-toggle"
            aria-expanded={filtersOpen}
            aria-controls="inbox-filters"
            aria-label={
              activeFilters > 0
                ? t('list.filtersCount', { count: activeFilters })
                : t('list.filters')
            }
            title={t('list.filters')}
            onClick={() => setFiltersOpen((open) => !open)}
            className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-lg border transition-colors ${
              filtersOpen || activeFilters > 0
                ? 'border-primary bg-primary-soft text-primary-fg'
                : 'border-line bg-surface text-muted hover:bg-surface-2'
            }`}
          >
            <Icon name="sliders" />
            {activeFilters > 0 ? (
              <span className="absolute -top-1 -right-1 rounded-full bg-primary px-1.5 text-xs leading-5 text-white">
                {activeFilters}
              </span>
            ) : null}
          </button>
        </div>
        {filtersOpen ? (
          <div
            id="inbox-filters"
            className="grid grid-cols-2 gap-2"
            data-testid="inbox-filters"
          >
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
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
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
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
            <label className="col-span-2 flex min-w-0 flex-col gap-1 text-xs text-muted">
              {t('list.filterTag')}
              <Select
                value={tagId}
                onChange={(e) => setTagId(e.target.value)}
                data-testid="inbox-filter-tag"
              >
                <option value="">{t('list.anyTag')}</option>
                {(tagList.data?.items ?? []).map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        ) : null}
      </div>
      <ul
        className="min-h-0 flex-1 overflow-y-auto border-t border-line"
        data-testid="conversation-list"
      >
        {/* The chips row appears once the accounts load: rows wait for it too,
            so nothing jumps under a click (e2e 2026-11-23). */}
        {query.isPending || accounts.isPending ? (
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
        {query.isSuccess && !accounts.isPending && items.length === 0 ? (
          <li className="flex flex-col items-center gap-3 px-6 py-12 text-center text-muted">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2">
              <Icon name={filtered ? 'search' : 'inbox'} className="h-6 w-6" />
            </span>
            <p>{filtered ? t('list.emptyFiltered') : t('list.empty')}</p>
          </li>
        ) : null}
        {(accounts.isPending ? [] : items).map((item) => (
          <ConversationRow
            key={item.id}
            item={item}
            now={now}
            selected={props.selectedId === item.id}
            timeZone={props.timeZone}
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
  timeZone?: string;
  onSelect: (id: string) => void;
}): ReactNode {
  const { t, locale } = useI18n();
  const { item, now } = props;
  const minutes = item.waitingSince
    ? Math.max(0, Math.floor((now - Date.parse(item.waitingSince)) / 60_000))
    : null;
  const overdue = item.slaDueAt ? Date.parse(item.slaDueAt) < now : false;
  const unread = !props.selected && isUnread(item.id, item.updatedAt);
  const last = item.lastMessage;
  // The usual state (the assistant answering) and a cold lead say nothing:
  // only what needs a person, or what is notable, gets a chip.
  const chips: ReactNode[] = [];
  if (item.state === 'WAITING_OPERATOR')
    chips.push(
      <Badge key="wait" tone="warning" dot>
        {minutes !== null
          ? t('list.waitingFor', { minutes })
          : t('state.WAITING_OPERATOR')}
      </Badge>,
    );
  if (item.state === 'OPERATOR_ACTIVE')
    chips.push(
      <Badge key="op" tone="accent">
        <Icon name="headset" className="h-3 w-3" />
        {t('state.OPERATOR_ACTIVE')}
      </Badge>,
    );
  if (item.state === 'CLOSED')
    chips.push(<Badge key="closed">{t('state.CLOSED')}</Badge>);
  if (overdue)
    chips.push(
      <Badge key="sla" tone="danger">
        <Icon name="clock" className="h-3 w-3" />
        {t('list.sla')}
      </Badge>,
    );
  // The assistant's lead score, labelled as such: a tenant may name sales
  // stages "warm" or "cold" too, and the two must not read as one thing.
  if (item.leadScore === 'HOT' || item.leadScore === 'WARM')
    chips.push(
      <Badge
        key="score"
        tone={SCORE_TONE[item.leadScore]}
        title={t('list.scoreHint')}
      >
        {t('list.scoreChip', { score: t(`score.${item.leadScore}`) })}
      </Badge>,
    );
  // Chat tags (ADR 071): the first two, then "+N" so the row stays one line.
  const tags = item.tags ?? [];
  for (const tag of tags.slice(0, 2))
    chips.push(
      <Badge key={`tag-${tag.id}`}>
        <span data-testid="conversation-item-tag" className="max-w-24 truncate">
          {tag.name}
        </span>
      </Badge>,
    );
  if (tags.length > 2)
    chips.push(<Badge key="tag-more">{`+${tags.length - 2}`}</Badge>);
  return (
    <li>
      <button
        type="button"
        data-testid="conversation-item"
        data-id={item.id}
        aria-current={props.selected}
        onClick={() => props.onSelect(item.id)}
        className={`flex w-full items-start gap-3 border-b border-line px-3 py-2.5 text-left transition-colors hover:bg-surface-2 ${
          props.selected ? 'bg-primary-soft hover:bg-primary-soft' : ''
        }`}
      >
        <span className="relative shrink-0">
          <Avatar name={item.contactName} />
          <ChannelLogo
            channelType={item.channelType}
            className="absolute right-0 bottom-0 h-4 w-4 rounded-full ring-2 ring-surface"
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline justify-between gap-2">
            {/* Customer-provided name: text only. */}
            <span
              className={`truncate ${unread ? 'font-semibold' : 'font-medium'}`}
            >
              {item.contactName ?? t('list.unnamed')}
            </span>
            <span className="shrink-0 text-xs text-muted tabular-nums">
              {shortTime(
                last?.at ?? item.updatedAt,
                now,
                locale,
                props.timeZone,
              )}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-muted">
              {last && (last.author === 'BOT' || last.author === 'OPERATOR') ? (
                <>
                  <Icon
                    name={last.author === 'BOT' ? 'bot' : 'headset'}
                    className="mr-1 inline h-3.5 w-3.5 align-[-2px]"
                  />
                  <span className="sr-only">
                    {t(`list.by.${last.author}`)}:{' '}
                  </span>
                </>
              ) : null}
              {/* Customer text is untrusted: plain text only, never HTML. */}
              {last
                ? isStartCommand(last.text)
                  ? t('message.botStarted')
                  : last.text
                : t('list.noMessages')}
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
          {chips.length > 0 ? (
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              {chips}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
