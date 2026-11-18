'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditLogPage,
} from '@/lib/types';
import { useShell } from './app-shell';
import { SettingsSubPage } from './settings-section-nav';
import { Button } from './ui/button';
import { EmptyState, QueryState } from './ui/error-note';
import { Select } from './ui/select';

const PAGE_SIZE = 50;

/** Ids and counts as short text (summaries never hold a name, phone or text). */
function summaryText(summary: unknown): string {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary))
    return '';
  return Object.entries(summary as Record<string, unknown>)
    .filter(
      ([, value]) =>
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean',
    )
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ');
}

/**
 * Settings → History (ADR 074): who changed what in the workspace, newest
 * first, with a category filter. Owners and admins only.
 */
export function AuditLogPage(): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { operator } = useShell();
  const manager = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState<AuditCategory | ''>('');
  const query = useQuery({
    queryKey: ['audit-events', category, page],
    queryFn: () =>
      api<AuditLogPage>(
        `/api/v1/audit-events?page=${page}&pageSize=${PAGE_SIZE}${
          category ? `&category=${category}` : ''
        }`,
      ),
    placeholderData: keepPreviousData,
    enabled: manager,
  });
  const data = query.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const label = (action: string): string => {
    const key = `audit.a.${action}`;
    const text = t(key);
    return text === key ? action : text;
  };
  const actor = (event: AuditLogPage['events'][number]): string =>
    event.actor ??
    t(
      event.actorType === 'CUSTOMER'
        ? 'audit.actor.customer'
        : event.actorType === 'ADMIN'
          ? 'audit.actor.platform'
          : event.actorType === 'OPERATOR'
            ? 'audit.actor.removed'
            : 'audit.actor.system',
    );

  return (
    <SettingsSubPage active="history">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('settings.section.history')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 sm:p-6">
          {!manager ? (
            <p role="status" className="text-sm text-muted">
              {t('team.managersOnly')}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted">{t('audit.intro')}</p>
              <label className="flex max-w-xs flex-col gap-1 text-sm">
                <span className="font-medium">{t('audit.category')}</span>
                <Select
                  value={category}
                  data-testid="audit-category"
                  onChange={(event) => {
                    setCategory(event.target.value as AuditCategory | '');
                    setPage(1);
                  }}
                >
                  <option value="">{t('audit.category.all')}</option>
                  {AUDIT_CATEGORIES.map((key) => (
                    <option key={key} value={key}>
                      {t(`audit.category.${key}`)}
                    </option>
                  ))}
                </Select>
              </label>
              <QueryState
                pending={query.isPending}
                error={query.error}
                onRetry={() => void query.refetch()}
              />
              {data && data.events.length === 0 ? (
                <EmptyState icon="note" text={t('audit.empty')} />
              ) : null}
              <ol className="flex flex-col gap-2">
                {(data?.events ?? []).map((event) => (
                  <li
                    key={event.id}
                    data-testid="audit-row"
                    className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface p-3 text-sm shadow-card"
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold break-words">
                        {label(event.action)}
                      </span>
                      <time
                        dateTime={event.createdAt}
                        className="text-xs text-muted"
                      >
                        {formatDateTime(event.createdAt)}
                      </time>
                    </span>
                    <span className="text-muted">
                      {t('audit.by', { actor: actor(event) })}
                      {' · '}
                      {t(`audit.category.${event.category}`)}
                    </span>
                    {summaryText(event.summary) ? (
                      <span className="font-mono text-xs break-all text-muted">
                        {summaryText(event.summary)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
              {data && data.total > 0 ? (
                <nav
                  aria-label={t('audit.pages')}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <Button
                    size="sm"
                    icon="chevronLeft"
                    disabled={page <= 1}
                    data-testid="audit-prev"
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                  >
                    {t('audit.newer')}
                  </Button>
                  <span className="text-sm text-muted" data-testid="audit-page">
                    {t('audit.page', { page, pages })}
                  </span>
                  <Button
                    size="sm"
                    disabled={page >= pages}
                    data-testid="audit-next"
                    onClick={() => setPage((value) => value + 1)}
                  >
                    {t('audit.older')}
                  </Button>
                </nav>
              ) : null}
            </>
          )}
        </div>
      </div>
    </SettingsSubPage>
  );
}
