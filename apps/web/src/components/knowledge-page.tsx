'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { FaqItem } from '@/lib/types';
import { useShell } from './app-shell';
import { FaqDialog, type FaqDraft } from './faq-dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

interface FaqList {
  embeddingsConfigured: boolean;
  limits: { question: number; answer: number };
  items: FaqItem[];
}

/** The tenant's FAQ: questions with answers the assistant may quote. */
export function KnowledgePage(): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { operator, timeZone } = useShell();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canChange = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<FaqItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<FaqItem | null>(null);

  const query = useQuery({
    queryKey: ['faq'],
    queryFn: () => api<FaqList>('/api/v1/knowledge/faq'),
  });
  const save = useMutation({
    mutationFn: (draft: FaqDraft) => {
      const body = {
        question: draft.question,
        answer: draft.answer,
        language: draft.language || null,
        regulated: draft.regulated,
        confirmProviderMayReadText: true,
      };
      return editing && editing !== 'new'
        ? api(`/api/v1/knowledge/faq/${editing.id}`, { method: 'PUT', body })
        : api('/api/v1/knowledge/faq', { method: 'POST', body });
    },
    onSuccess: () => {
      toast(t('toast.faqSaved'));
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['faq'] });
    },
  });
  const remove = useMutation({
    mutationFn: (item: FaqItem) =>
      api(`/api/v1/knowledge/faq/${item.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast(t('toast.faqDeleted'));
      void queryClient.invalidateQueries({ queryKey: ['faq'] });
    },
    onSettled: () => setDeleting(null),
  });

  const all = query.data?.items ?? [];
  const needle = search.trim().toLocaleLowerCase();
  const items = needle
    ? all.filter(
        (item) =>
          item.question.toLocaleLowerCase().includes(needle) ||
          item.answer.toLocaleLowerCase().includes(needle),
      )
    : all;
  const configured = query.data?.embeddingsConfigured ?? true;

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.knowledge')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('knowledge.intro')}</p>
        {query.isSuccess && !configured ? (
          <p
            role="status"
            data-testid="knowledge-not-configured"
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

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
              <Icon name="search" />
            </span>
            <input
              type="search"
              aria-label={t('knowledge.search')}
              placeholder={t('knowledge.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${fieldClass} pl-9`}
            />
          </div>
          {query.isSuccess ? (
            <span
              data-testid="faq-count"
              className="text-sm whitespace-nowrap text-muted"
            >
              {t('knowledge.count', { count: all.length })}
            </span>
          ) : null}
          {canChange ? (
            <Button
              variant="primary"
              icon="plus"
              disabled={!configured}
              data-testid="faq-add"
              onClick={() => {
                save.reset();
                setEditing('new');
              }}
            >
              {t('knowledge.add')}
            </Button>
          ) : null}
        </div>

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
              <Icon name="book" className="h-6 w-6" />
            </span>
            <p>
              {needle ? t('knowledge.emptyFiltered') : t('knowledge.empty')}
            </p>
          </div>
        ) : null}

        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="faq-item"
              className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card"
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                {/* Admin-written text, still shown as plain text. */}
                <h2 className="min-w-0 font-medium break-words">
                  {item.question}
                </h2>
                {canChange ? (
                  <span className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="pencil"
                      data-testid="faq-edit"
                      onClick={() => {
                        save.reset();
                        setEditing(item);
                      }}
                    >
                      <span className="sr-only">
                        {t('knowledge.edit')}: {item.question}
                      </span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      data-testid="faq-delete"
                      onClick={() => {
                        remove.reset();
                        setDeleting(item);
                      }}
                    >
                      <span className="sr-only">
                        {t('knowledge.delete')}: {item.question}
                      </span>
                    </Button>
                  </span>
                ) : null}
              </div>
              <p className="text-sm break-words whitespace-pre-wrap text-muted">
                {item.answer}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                {item.language ? (
                  <Badge className="uppercase">{item.language}</Badge>
                ) : null}
                {item.regulated ? (
                  <Badge tone="warning">{t('knowledge.regulatedBadge')}</Badge>
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

      <FaqDialog
        open={editing !== null}
        item={editing && editing !== 'new' ? editing : null}
        limits={query.data?.limits ?? { question: 200, answer: 600 }}
        busy={save.isPending}
        error={save.error}
        onSave={(draft) => save.mutate(draft)}
        onCancel={() => setEditing(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={t('knowledge.deleteTitle')}
        body={t('knowledge.deleteBody')}
        confirmLabel={t('knowledge.delete')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
