'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { isUnread } from '@/lib/seen';
import type { ConversationPage, Scope } from '@/lib/types';
import { useNow } from '@/lib/use-now';

const SCOPES: Scope[] = ['waiting', 'mine', 'all', 'closed'];
const LANGUAGES = ['uz', 'ru', 'en'];
const SCORES = ['HOT', 'WARM', 'COLD'];

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
  onScope: (scope: Scope) => void;
  onSelect: (id: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('');
  const [score, setScore] = useState('');
  const q = useDebounced(search.trim(), 300);
  const now = useNow();

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        className="flex border-b border-slate-200 dark:border-slate-700"
      >
        {SCOPES.map((scope) => (
          <button
            key={scope}
            role="tab"
            type="button"
            aria-selected={props.scope === scope}
            onClick={() => props.onScope(scope)}
            className={`flex-1 px-2 py-2 text-sm ${props.scope === scope ? 'border-b-2 border-indigo-600 font-semibold' : 'text-slate-600 dark:text-slate-400'}`}
          >
            {t(`scope.${scope}`)}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <input
          type="search"
          aria-label={t('list.search')}
          placeholder={t('list.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        <div className="flex gap-2">
          <select
            aria-label={t('list.filterLanguage')}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">
              {t('list.filterLanguage')}: {t('list.any')}
            </option>
            {LANGUAGES.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <select
            aria-label={t('list.filterScore')}
            value={score}
            onChange={(e) => setScore(e.target.value)}
            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">
              {t('list.filterScore')}: {t('list.any')}
            </option>
            {SCORES.map((id) => (
              <option key={id} value={id}>
                {t(`score.${id}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ul
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="conversation-list"
      >
        {query.isPending ? <li className="p-4">{t('app.loading')}</li> : null}
        {query.isError ? (
          <li className="p-4">
            <p role="alert">{t(errorKey(query.error))}</p>
            <button
              type="button"
              className="underline"
              onClick={() => void query.refetch()}
            >
              {t('app.retry')}
            </button>
          </li>
        ) : null}
        {query.isSuccess && items.length === 0 ? (
          <li className="p-4 text-slate-600 dark:text-slate-400">
            {t('list.empty')}
          </li>
        ) : null}
        {items.map((item) => {
          const minutes = item.waitingSince
            ? Math.max(
                0,
                Math.floor((now - Date.parse(item.waitingSince)) / 60_000),
              )
            : null;
          const overdue = item.slaDueAt
            ? Date.parse(item.slaDueAt) < now
            : false;
          const unread =
            item.id !== props.selectedId && isUnread(item.id, item.updatedAt);
          return (
            <li key={item.id}>
              <button
                type="button"
                data-testid="conversation-item"
                data-id={item.id}
                aria-current={props.selectedId === item.id}
                onClick={() => props.onSelect(item.id)}
                className={`flex w-full flex-col gap-1 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-800 ${props.selectedId === item.id ? 'bg-indigo-50 dark:bg-slate-800' : ''}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {item.contactName ?? t('list.unnamed')}
                  </span>
                  {unread ? (
                    <span
                      aria-label={t('list.unread')}
                      title={t('list.unread')}
                      className="h-2 w-2 rounded-full bg-indigo-600"
                    />
                  ) : null}
                </span>
                <span className="flex flex-wrap gap-2 text-xs text-slate-600 dark:text-slate-400">
                  <span>{t(`state.${item.state}`)}</span>
                  {item.leadScore ? (
                    <span>{t(`score.${item.leadScore}`)}</span>
                  ) : null}
                  {minutes !== null && item.state === 'WAITING_OPERATOR' ? (
                    <span>{t('list.waitingFor', { minutes })}</span>
                  ) : null}
                  {overdue ? (
                    <span className="font-semibold text-amber-700 dark:text-amber-400">
                      {t('list.sla')}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {query.hasNextPage ? (
          <li className="p-3">
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              className="w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-600"
            >
              {query.isFetchingNextPage ? t('app.loading') : t('list.loadMore')}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
