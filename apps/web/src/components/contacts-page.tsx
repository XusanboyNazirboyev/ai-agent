'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { channelName } from '@/lib/channel-names';
import type {
  PersonDuplicateGroup,
  PersonItem,
  PersonList,
  Tag,
} from '@/lib/types';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button, buttonClass } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return (): void => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** People list (P1.1): one row per person across channels. */
export function ContactsPage(): ReactNode {
  const { t } = useI18n();
  const { timeZone } = useShell();
  const [search, setSearch] = useState('');
  const [tagId, setTagId] = useState('');
  const [tab, setTab] = useState<'people' | 'duplicates'>('people');
  const q = useDebounced(search.trim(), 300);

  const tagsQuery = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ items: Tag[] }>('/api/v1/tags'),
    enabled: tab === 'people',
  });

  const query = useInfiniteQuery({
    queryKey: ['people', q, tagId],
    initialPageParam: '',
    enabled: tab === 'people',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (pageParam) params.set('cursor', pageParam);
      if (q) params.set('q', q);
      if (tagId) params.set('tagId', tagId);
      return api<PersonList>(`/api/v1/people?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  const duplicates = useQuery({
    queryKey: ['people', 'duplicates'],
    enabled: tab === 'duplicates',
    queryFn: () =>
      api<{ groups: PersonDuplicateGroup[] }>('/api/v1/people/duplicates'),
  });
  const groups = duplicates.data?.groups ?? [];

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.contacts')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('people.intro')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={tab === 'people' ? 'primary' : 'secondary'}
            onClick={() => setTab('people')}
            data-testid="people-tab-list"
          >
            {t('people.peopleList')}
          </Button>
          <Button
            size="sm"
            variant={tab === 'duplicates' ? 'primary' : 'secondary'}
            onClick={() => setTab('duplicates')}
            data-testid="people-tab-duplicates"
          >
            {t('people.duplicatesReview')}
          </Button>
        </div>

        {tab === 'people' ? (
          <>
            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-0 flex-1 basis-56">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                  <Icon name="search" />
                </span>
                <input
                  type="search"
                  aria-label={t('people.search')}
                  placeholder={t('people.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={`${fieldClass} pl-9`}
                />
              </div>
              <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-sm">
                <span className="sr-only">{t('people.filterByTag')}</span>
                <select
                  aria-label={t('people.filterByTag')}
                  data-testid="people-tag-filter"
                  value={tagId}
                  onChange={(e) => setTagId(e.target.value)}
                  className={fieldClass}
                >
                  <option value="">{t('people.allTags')}</option>
                  {(tagsQuery.data?.items ?? []).map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {query.isPending ? (
              <div
                role="status"
                className="overflow-hidden rounded-2xl border border-line bg-surface"
              >
                <span className="sr-only">{t('app.loading')}</span>
                <SkeletonRows rows={4} />
              </div>
            ) : null}
            {query.isError ? (
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
            ) : null}
            {query.isSuccess && items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center text-muted">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2">
                  <Icon name="users" className="h-6 w-6" />
                </span>
                <p>{q ? t('people.emptyFiltered') : t('people.empty')}</p>
              </div>
            ) : null}

            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <PersonRow key={item.id} item={item} timeZone={timeZone} />
              ))}
              {query.hasNextPage ? (
                <li>
                  <Button
                    className="w-full"
                    loading={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {query.isFetchingNextPage
                      ? t('app.loading')
                      : t('list.loadMore')}
                  </Button>
                </li>
              ) : null}
            </ul>
          </>
        ) : (
          <DuplicatesReview
            groups={groups}
            pending={duplicates.isPending}
            error={duplicates.error}
            onRetry={() => void duplicates.refetch()}
            timeZone={timeZone}
          />
        )}
      </div>
    </div>
  );
}

function PersonRow(props: {
  item: PersonItem;
  timeZone: string | undefined;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { item } = props;
  return (
    <li
      data-testid="person-item"
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-line bg-surface p-3 shadow-card sm:p-4"
    >
      <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <Avatar name={item.displayName} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium">
            {item.displayName ?? t('list.unnamed')}
          </span>
          <span className="truncate text-sm text-muted">
            {item.phone ?? t('view.noPhone')}
          </span>
        </span>
      </span>
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {item.channels.map((ch) => (
            <Badge key={`${ch.contactId}-${ch.channelType}`}>
              {channelName(ch.channelType)}
            </Badge>
          ))}
          {(item.tags ?? []).map((tag) => (
            <Badge key={tag.id} tone="accent" data-testid="person-row-tag">
              {tag.name}
            </Badge>
          ))}
          <Badge tone="accent">
            {t('people.conversations', { count: item.conversationCount })}
          </Badge>
          <Badge tone="accent">
            {t('people.leads', { count: item.leadCount })}
          </Badge>
          {item.marketingOptOut ? (
            <Badge tone="warning">{t('people.optedOut')}</Badge>
          ) : null}
        </span>
        <span className="text-xs text-muted">
          {item.lastActivityAt
            ? t('people.lastActive', {
                date: formatDateTime(item.lastActivityAt, props.timeZone),
              })
            : t('people.never')}
        </span>
      </span>
      <span className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
        {item.lastConversationId ? (
          <Link
            href={`/inbox?scope=all&c=${item.lastConversationId}`}
            className={buttonClass('secondary', 'sm')}
          >
            <Icon name="message" />
            {t('people.open')}
          </Link>
        ) : null}
        <Link
          href={`/contacts/${item.id}`}
          className={buttonClass('secondary', 'sm')}
          data-testid="person-open-card"
        >
          <Icon name="users" />
          {t('people.openCard')}
        </Link>
      </span>
    </li>
  );
}

function DuplicatesReview(props: {
  groups: PersonDuplicateGroup[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  timeZone: string | undefined;
}): ReactNode {
  const { t } = useI18n();
  if (props.pending) {
    return (
      <div
        role="status"
        className="overflow-hidden rounded-2xl border border-line bg-surface"
      >
        <span className="sr-only">{t('app.loading')}</span>
        <SkeletonRows rows={3} />
      </div>
    );
  }
  if (props.error) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" />
          {t(errorKey(props.error))}
        </p>
        <Button size="sm" onClick={props.onRetry}>
          {t('app.retry')}
        </Button>
      </div>
    );
  }
  if (props.groups.length === 0) {
    return (
      <div
        data-testid="duplicate-group-empty"
        className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center text-muted"
      >
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2">
          <Icon name="users" className="h-6 w-6" />
        </span>
        <p>{t('people.duplicatesEmpty')}</p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {props.groups.map((group, idx) => (
        <li
          key={`${group.reason}-${idx}`}
          data-testid="duplicate-group"
          className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card"
        >
          <p className="text-sm font-medium text-muted">
            {t('people.duplicateGroup')}
          </p>
          <ul className="flex flex-col gap-2">
            {group.persons.map((person) => (
              <li
                key={person.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3"
              >
                <span className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
                  <span className="truncate font-medium">
                    {person.displayName ?? t('list.unnamed')}
                  </span>
                  {person.phone ? (
                    <span className="truncate text-sm text-muted">
                      {person.phone}
                    </span>
                  ) : null}
                  <span className="flex flex-wrap gap-1.5">
                    {person.channels.map((ch) => (
                      <Badge key={`${ch.contactId}-${ch.channelType}`}>
                        {channelName(ch.channelType)}
                      </Badge>
                    ))}
                  </span>
                </span>
                <Link
                  href={`/contacts/${person.id}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  <Icon name="users" />
                  {t('people.openCard')}
                </Link>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
