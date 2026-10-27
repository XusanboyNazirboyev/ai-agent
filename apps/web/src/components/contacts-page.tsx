'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ContactItem } from '@/lib/types';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button, buttonClass } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

interface ContactPage {
  items: ContactItem[];
  nextCursor: string | null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return (): void => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Everyone who has written in, newest first, with a link to their latest chat. */
export function ContactsPage(): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { timeZone } = useShell();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);

  const query = useInfiniteQuery({
    queryKey: ['contacts', q],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (pageParam) params.set('cursor', pageParam);
      if (q) params.set('q', q);
      return api<ContactPage>(`/api/v1/contacts?${params.toString()}`);
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
        <p className="text-sm text-muted">{t('contacts.intro')}</p>
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            <Icon name="search" />
          </span>
          <input
            type="search"
            aria-label={t('contacts.search')}
            placeholder={t('contacts.search')}
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
            <p>{q ? t('contacts.emptyFiltered') : t('contacts.empty')}</p>
          </div>
        ) : null}

        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="contact-item"
              className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-line bg-surface p-3 shadow-card sm:p-4"
            >
              <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                <Avatar name={item.name} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  {/* Customer-provided name and phone: text only. */}
                  <span className="truncate font-medium">
                    {item.name ?? t('list.unnamed')}
                  </span>
                  <span className="truncate text-sm text-muted">
                    {item.phone ?? t('view.noPhone')}
                  </span>
                </span>
              </span>
              <span className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge>{item.channelType}</Badge>
                  {item.language ? (
                    <Badge className="uppercase">{item.language}</Badge>
                  ) : null}
                  <Badge tone="accent">
                    {t('contacts.conversations', {
                      count: item.conversationCount,
                    })}
                  </Badge>
                  {item.marketingOptOut ? (
                    <Badge tone="warning">{t('contacts.optedOut')}</Badge>
                  ) : null}
                </span>
                <span className="text-xs text-muted">
                  {item.lastActivityAt
                    ? t('contacts.lastActive', {
                        date: formatDateTime(item.lastActivityAt, timeZone),
                      })
                    : t('contacts.never')}
                </span>
              </span>
              {item.lastConversationId ? (
                <Link
                  href={`/inbox?scope=all&c=${item.lastConversationId}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  <Icon name="message" />
                  {t('contacts.open')}
                </Link>
              ) : null}
            </li>
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
