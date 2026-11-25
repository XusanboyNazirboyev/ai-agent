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
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

export interface KnowledgeGap {
  ids: string[];
  question: string;
  count: number;
  lastAskedAt: string;
  conversationId: string;
}

/**
 * ADR 091: what customers asked that the bot could not answer. The owner
 * adds the answer as a FAQ entry (saving it is the confirmation) or
 * dismisses the question.
 */
export function KnowledgeGapsPanel(): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { operator, timeZone } = useShell();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canChange = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [answering, setAnswering] = useState<KnowledgeGap | null>(null);
  const query = useQuery({
    queryKey: ['knowledge-gaps'],
    queryFn: () => api<{ items: KnowledgeGap[] }>('/api/v1/knowledge/gaps'),
  });
  const faq = useQuery({
    queryKey: ['faq'],
    queryFn: () =>
      api<{ limits: { question: number; answer: number } }>(
        '/api/v1/knowledge/faq',
      ),
  });
  const resolve = (gap: KnowledgeGap, resolution: 'ANSWERED' | 'DISMISSED') =>
    api('/api/v1/knowledge/gaps/resolve', {
      method: 'POST',
      body: { ids: gap.ids, resolution },
    });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['knowledge-gaps'] });
    void queryClient.invalidateQueries({ queryKey: ['faq'] });
  };
  const answer = useMutation({
    mutationFn: async (draft: FaqDraft) => {
      await api('/api/v1/knowledge/faq', {
        method: 'POST',
        body: {
          question: draft.question,
          answer: draft.answer,
          language: draft.language || null,
          regulated: draft.regulated,
          confirmProviderMayReadText: true,
        },
      });
      if (answering) await resolve(answering, 'ANSWERED');
    },
    onSuccess: () => {
      toast(t('toast.faqSaved'));
      setAnswering(null);
      refresh();
    },
  });
  const dismiss = useMutation({
    mutationFn: (gap: KnowledgeGap) => resolve(gap, 'DISMISSED'),
    onSuccess: refresh,
  });
  const items = query.data?.items ?? [];
  const prefill: FaqItem | null = answering
    ? {
        id: '',
        question: answering.question,
        answer: '',
        language: null,
        regulated: false,
        updatedAt: answering.lastAskedAt,
      }
    : null;

  return (
    <>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('knowledge.gaps.intro')}</p>
        {query.isPending ? <SkeletonRows rows={3} /> : null}
        {query.isError ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(query.error))}
          </p>
        ) : null}
        {dismiss.isError ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(dismiss.error))}
          </p>
        ) : null}
        {query.isSuccess && items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center text-muted">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2">
              <Icon name="check" className="h-6 w-6" />
            </span>
            <p>{t('knowledge.gaps.empty')}</p>
          </div>
        ) : null}
        <ul className="flex flex-col gap-3">
          {items.map((gap) => (
            <li
              key={gap.ids[0]}
              data-testid="gap-item"
              className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card"
            >
              {/* Customer text: untrusted, shown as plain text only. */}
              <p className="min-w-0 font-medium break-words">{gap.question}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                {gap.count > 1 ? (
                  <Badge tone="warning">
                    {t('knowledge.gaps.asked', { count: gap.count })}
                  </Badge>
                ) : null}
                <span>
                  {t('knowledge.gaps.last', {
                    date: formatDateTime(gap.lastAskedAt, timeZone),
                  })}
                </span>
              </div>
              {canChange ? (
                <span className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    icon="plus"
                    data-testid="gap-answer"
                    onClick={() => {
                      answer.reset();
                      setAnswering(gap);
                    }}
                  >
                    {t('knowledge.gaps.answer')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="gap-dismiss"
                    loading={dismiss.isPending && dismiss.variables === gap}
                    onClick={() => dismiss.mutate(gap)}
                  >
                    {t('knowledge.gaps.dismiss')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <FaqDialog
        open={answering !== null}
        item={prefill}
        limits={faq.data?.limits ?? { question: 200, answer: 600 }}
        busy={answer.isPending}
        error={answer.error}
        onSave={(draft) => answer.mutate(draft)}
        onCancel={() => setAnswering(null)}
      />
    </>
  );
}
