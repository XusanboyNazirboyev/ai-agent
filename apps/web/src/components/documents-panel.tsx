'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { KnowledgeDocumentItem } from '@/lib/types';
import { useShell } from './app-shell';
import { DocumentDialog, type DocumentDraft } from './document-dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

interface DocumentList {
  embeddingsConfigured: boolean;
  limits: { text: number; title: number };
  items: KnowledgeDocumentItem[];
}

/** The Documents tab: text documents the assistant can search. */
export function DocumentsPanel(): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { operator, timeZone } = useShell();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canChange = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeDocumentItem | null>(null);

  const query = useQuery({
    queryKey: ['documents'],
    queryFn: () => api<DocumentList>('/api/v1/knowledge/documents'),
  });
  const upload = useMutation({
    mutationFn: (draft: DocumentDraft) =>
      api('/api/v1/knowledge/documents', {
        method: 'POST',
        body: {
          title: draft.title,
          text: draft.text,
          language: draft.language || null,
          topic: draft.topic || null,
          regulated: draft.regulated,
          confirmProviderMayReadText: true,
        },
      }),
    onSuccess: () => {
      toast(t('toast.documentSaved'));
      setUploading(false);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
  const remove = useMutation({
    mutationFn: (item: KnowledgeDocumentItem) =>
      api(`/api/v1/knowledge/documents/${item.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast(t('toast.documentDeleted'));
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onSettled: () => setDeleting(null),
  });

  const items = query.data?.items ?? [];
  const configured = query.data?.embeddingsConfigured ?? true;
  const limits = query.data?.limits ?? { text: 40000, title: 150 };

  return (
    <>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('documents.intro')}</p>
        {query.isSuccess && !configured ? (
          <p
            role="status"
            data-testid="documents-not-configured"
            className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('knowledge.notConfigured')}
          </p>
        ) : null}
        {!canChange ? (
          <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm text-muted">
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('knowledge.readOnly')}
          </p>
        ) : null}
        {remove.isError ? (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" />
            {t(errorKey(remove.error))}
          </p>
        ) : null}
        {canChange ? (
          <div>
            <Button
              variant="primary"
              icon="plus"
              disabled={!configured}
              data-testid="document-upload"
              onClick={() => {
                upload.reset();
                setUploading(true);
              }}
            >
              {t('documents.upload')}
            </Button>
          </div>
        ) : null}

        {query.isPending ? (
          <div
            role="status"
            className="overflow-hidden rounded-2xl border border-line bg-surface"
          >
            <span className="sr-only">{t('app.loading')}</span>
            <SkeletonRows rows={3} />
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
              <Icon name="note" className="h-6 w-6" />
            </span>
            <p>{t('documents.empty')}</p>
          </div>
        ) : null}

        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="document-item"
              className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card"
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                {/* Admin-written text, still shown as plain text. */}
                <h2 className="min-w-0 font-medium break-words">
                  {item.title}
                </h2>
                {canChange ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    data-testid="document-delete"
                    onClick={() => {
                      remove.reset();
                      setDeleting(item);
                    }}
                  >
                    <span className="sr-only">
                      {t('documents.delete')}: {item.title}
                    </span>
                  </Button>
                ) : null}
              </div>
              {item.preview ? (
                <p className="line-clamp-3 text-sm break-words text-muted">
                  {item.preview}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <Badge tone="accent">
                  {t('documents.chunks', { count: item.chunks })}
                </Badge>
                <Badge>
                  {t('documents.characters', { count: item.characters })}
                </Badge>
                {item.language ? (
                  <Badge className="uppercase">{item.language}</Badge>
                ) : null}
                {item.topic ? <Badge>{item.topic}</Badge> : null}
                {item.regulated ? (
                  <Badge tone="warning">{t('knowledge.regulatedBadge')}</Badge>
                ) : null}
                {item.origin === 'admin' ? (
                  <Badge>{t('documents.admin')}</Badge>
                ) : null}
                <span>
                  {t('knowledge.updated', {
                    date: formatDateTime(item.updatedAt, timeZone),
                  })}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <DocumentDialog
        open={uploading}
        limits={limits}
        busy={upload.isPending}
        error={upload.error}
        onSave={(draft) => upload.mutate(draft)}
        onCancel={() => setUploading(false)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={t('documents.deleteTitle')}
        body={t('documents.deleteBody')}
        confirmLabel={t('documents.delete')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
