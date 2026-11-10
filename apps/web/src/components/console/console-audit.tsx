'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import type { AuditPage } from '@/lib/platform-types';
import { Button } from '../ui/button';
import { EmptyState, QueryState } from '../ui/error-note';

const PAGE_SIZE = 50;

/** Safe summary values as short text (they never hold personal data). */
function summaryText(summary: Record<string, unknown> | null): string {
  if (!summary) return '';
  return Object.entries(summary)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ');
}

/** The platform audit trail, newest first, paged. */
export function ConsoleAudit(): ReactNode {
  const { t, formatDateTime } = useI18n();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['platform', 'audit', page],
    queryFn: () =>
      platformApi<AuditPage>(
        `/api/v1/platform/audit?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <QueryState
        pending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      {data && data.events.length === 0 ? (
        <EmptyState icon="note" text={t('console.audit.empty')} />
      ) : null}
      <ol className="flex flex-col gap-2">
        {(data?.events ?? []).map((event) => (
          <li
            key={event.id}
            data-testid="audit-row"
            className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface p-3 text-sm shadow-card"
          >
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold break-all">
                {event.action}
              </span>
              <time dateTime={event.createdAt} className="text-xs text-muted">
                {formatDateTime(event.createdAt)}
              </time>
            </span>
            <span className="text-muted">
              {t('console.audit.by', {
                actor: event.actor ?? t('console.audit.system'),
              })}
              {event.tenant
                ? ` · ${event.tenant.name} (${event.tenant.slug})`
                : ''}
            </span>
            {event.summary && Object.keys(event.summary).length > 0 ? (
              <span className="text-xs break-words text-muted">
                {summaryText(event.summary)}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {data && data.total > 0 ? (
        <nav
          aria-label={t('console.audit.pages')}
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <Button
            size="sm"
            icon="chevronLeft"
            disabled={page <= 1}
            data-testid="audit-prev"
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            {t('console.audit.newer')}
          </Button>
          <span className="text-sm text-muted" data-testid="audit-page">
            {t('console.audit.page', { page, pages })}
          </span>
          <Button
            size="sm"
            disabled={page >= pages}
            data-testid="audit-next"
            onClick={() => setPage((value) => value + 1)}
          >
            {t('console.audit.older')}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
