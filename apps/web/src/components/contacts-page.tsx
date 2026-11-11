'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { channelName } from '@/lib/channel-names';
import type { PersonItem, PersonList } from '@/lib/types';
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
  const q = useDebounced(search.trim(), 300);

  const query = useInfiniteQuery({
    queryKey: ['people', q],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (pageParam) params.set('cursor', pageParam);
      if (q) params.set('q', q);
      return api<PersonList>(`/api/v1/people?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.contacts')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('people.intro')}</p>
        <div className="relative">
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
