'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { useShell } from './app-shell';
import { Button } from './ui/button';
import { textareaClass } from './ui/fields';

interface LeadNote {
  id: string;
  text: string;
  createdAt: string;
  author: { id: string; displayName: string } | null;
}

/** Internal notes of the lead: never sent to the customer. */
export function LeadNotes(props: { leadId: string }): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { operator, timeZone } = useShell();
  const qc = useQueryClient();
  const canWrite = operator.role !== 'VIEWER';
  const [text, setText] = useState('');
  const list = useQuery({
    queryKey: ['lead-notes', props.leadId],
    queryFn: () =>
      api<{ items: LeadNote[] }>(`/api/v1/leads/${props.leadId}/notes`),
  });
  const add = useMutation({
    mutationFn: (body: string) =>
      api<LeadNote>(`/api/v1/leads/${props.leadId}/notes`, {
        method: 'POST',
        body: { text: body },
      }),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['lead-notes', props.leadId] });
      void qc.invalidateQueries({ queryKey: ['lead-timeline', props.leadId] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
    },
  });
  const items = list.data?.items ?? [];
  function submit(event: FormEvent): void {
    event.preventDefault();
    const value = text.trim();
    if (value) add.mutate(value);
  }
  return (
    <div data-testid="lead-notes" className="flex min-h-0 flex-col gap-3">
      {canWrite ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <textarea
            aria-label={t('action.notePlaceholder')}
            placeholder={t('action.notePlaceholder')}
            value={text}
            maxLength={4096}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            className={`${textareaClass} text-sm`}
          />
          <div>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={add.isPending}
              disabled={!text.trim()}
              data-testid="lead-note-add"
            >
              {t('action.addNote')}
            </Button>
          </div>
          {add.isError ? (
            <p role="alert" className="text-sm text-danger-fg">
              {t(errorKey(add.error))}
            </p>
          ) : null}
        </form>
      ) : null}
      {list.isError ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t(errorKey(list.error))}
        </p>
      ) : items.length === 0 && !list.isPending ? (
        <p className="text-sm text-muted">{t('view.noNotes')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((note) => (
            <li
              key={note.id}
              data-testid="lead-note"
              className="rounded-lg bg-warning-soft p-3 text-sm text-warning-fg"
            >
              <p className="break-words whitespace-pre-wrap">{note.text}</p>
              <p className="mt-1 text-xs opacity-80">
                {formatDateTime(note.createdAt, timeZone)}
                {note.author ? ` · ${note.author.displayName}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
