'use client';

import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { LeadPipelineItem, LeadPipelinePage } from '@/lib/types';
import { useShell } from './app-shell';
import { useRefreshLeads } from './lead-archive-button';
import { Avatar } from './ui/avatar';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

/**
 * The archive of a pipeline (ADR 062): OWNER and ADMIN restore a lead, only
 * the OWNER deletes it for good, after a confirmation that says it cannot be
 * undone and that a copy already in the CRM stays.
 */
export function LeadsArchive(props: { pipelineId: string }): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const toast = useToast();
  const refresh = useRefreshLeads();
  const canDelete = operator.role === 'OWNER';
  const [deleting, setDeleting] = useState<LeadPipelineItem | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['leads', 'archive', props.pipelineId],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        pipelineId: props.pipelineId,
        archived: 'true',
        limit: '25',
      });
      if (pageParam) params.set('cursor', pageParam);
      return api<LeadPipelinePage>(`/api/v1/leads?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  const restore = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/leads/${id}/restore`, { method: 'POST' }),
    onSuccess: () => {
      toast(t('toast.leadRestored'));
      refresh();
    },
    onError: (e: unknown) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/leads/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      toast(t('toast.leadDeleted'));
      refresh();
    },
    onError: (e: unknown) => {
      setDeleting(null);
      toast(t(errorKey(e)));
    },
  });

  if (query.isPending) return <SkeletonRows rows={3} />;
  if (query.isError)
    return (
      <p role="alert" className="text-sm text-danger-fg">
        {t(errorKey(query.error))}
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="leads-archive">
      <p className="text-sm text-muted">{t('leads.archive.hint')}</p>
      {items.length === 0 ? (
        <p
          data-testid="leads-archive-empty"
          className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted"
        >
          {t('leads.archive.empty')}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {items.map((item) => {
            const name = item.contact.name ?? t('list.unnamed');
            return (
              <li
                key={item.id}
                data-testid="leads-archive-row"
                className="flex min-w-0 flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-3"
              >
                <Avatar name={name} />
                <div className="flex min-w-0 flex-1 basis-40 flex-col">
                  <span className="min-w-0 truncate font-medium">{name}</span>
                  <span className="min-w-0 truncate text-xs text-muted">
                    {[
                      item.contact.phone,
                      item.archivedAt
                        ? new Date(item.archivedAt).toLocaleDateString()
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={restore.isPending && restore.variables === item.id}
                    data-testid="lead-restore"
                    onClick={() => restore.mutate(item.id)}
                  >
                    {t('leads.restore')}
                  </Button>
                  {canDelete ? (
                    <Button
                      size="sm"
                      variant="danger"
                      data-testid="lead-delete-forever"
                      onClick={() => setDeleting(item)}
                    >
                      {t('leads.deleteForever')}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('list.loadMore')}
        </Button>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t('leads.deleteForever.title')}
        body={t('leads.deleteForever.body')}
        confirmLabel={t('leads.deleteForever')}
        cancelLabel={t('app.cancel')}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
