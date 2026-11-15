'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { CANNED_QUERY, useCannedResponses } from '@/lib/canned';
import type { CannedResponse } from '@/lib/types';
import { useShell } from './app-shell';
import { SettingsSubPage } from './settings-section-nav';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { fieldClass, textareaClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Section } from './ui/section';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

export function RepliesSettingsPage(): ReactNode {
  const { t } = useI18n();
  return (
    <SettingsSubPage active="replies">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('replies.title')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">{t('replies.title')}</h2>
            <p className="text-sm text-muted">{t('replies.intro')}</p>
          </div>
          <RepliesManager />
        </div>
      </div>
    </SettingsSubPage>
  );
}

function RepliesManager(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const canEdit = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const list = useCannedResponses();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<CannedResponse | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: CANNED_QUERY });
  };

  const save = useMutation({
    mutationFn: (body: { title: string; text: string }) =>
      editing
        ? api<CannedResponse>(`/api/v1/canned-responses/${editing.id}`, {
            method: 'PATCH',
            body,
          })
        : api<CannedResponse>('/api/v1/canned-responses', {
            method: 'POST',
            body,
          }),
    onSuccess: () => {
      toast(t(editing ? 'replies.saved' : 'replies.created'));
      setTitle('');
      setText('');
      setEditing(null);
      refresh();
    },
  });
  const move = useMutation({
    mutationFn: (input: { id: string; position: number }) =>
      api(`/api/v1/canned-responses/${input.id}`, {
        method: 'PATCH',
        body: { position: input.position },
      }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/canned-responses/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteId(null);
      toast(t('replies.deleted'));
      refresh();
    },
  });

  /** Swap with the neighbour: both get explicit positions, so the order holds. */
  function swap(index: number, by: -1 | 1): void {
    const a = list.items[index];
    const b = list.items[index + by];
    if (!a || !b) return;
    move.mutate({ id: a.id, position: index + by });
    move.mutate({ id: b.id, position: index });
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!title.trim() || !text.trim() || save.isPending) return;
    save.mutate({ title: title.trim(), text: text.trim() });
  }

  const err = save.error ?? remove.error ?? move.error;
  const target = deleteId
    ? list.items.find((item) => item.id === deleteId)
    : null;

  return (
    <Section title={t('replies.listTitle')} icon="message">
      {!canEdit ? (
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm text-muted">
          <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
          {t('settings.readOnly')}
        </p>
      ) : null}
      {err ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t(errorKey(err))}
        </p>
      ) : null}
      {canEdit ? (
        <form
          data-testid="reply-form"
          className="flex flex-col gap-2 rounded-xl border border-border p-3"
          onSubmit={submit}
        >
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('replies.name')}
            <input
              data-testid="reply-title"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('replies.namePlaceholder')}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('replies.text')}
            <textarea
              data-testid="reply-text"
              value={text}
              maxLength={2000}
              rows={3}
              onChange={(e) => setText(e.target.value)}
              className={textareaClass}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              icon={editing ? 'check' : 'plus'}
              loading={save.isPending}
              disabled={!title.trim() || !text.trim() || save.isPending}
              data-testid="reply-save"
            >
              {t(editing ? 'app.save' : 'replies.add')}
            </Button>
            {editing ? (
              <Button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setTitle('');
                  setText('');
                }}
              >
                {t('app.cancel')}
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {list.isPending ? (
        <div role="status">
          <span className="sr-only">{t('app.loading')}</span>
          <SkeletonRows rows={3} />
        </div>
      ) : null}
      {list.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(list.error))}
          </p>
          <Button size="sm" onClick={() => void list.refetch()}>
            {t('app.retry')}
          </Button>
        </div>
      ) : null}
      {!list.isPending && !list.isError && list.items.length === 0 ? (
        <p className="text-sm text-muted">{t('replies.empty')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {list.items.map((item, index) => (
          <li
            key={item.id}
            data-testid="reply-item"
            className="flex flex-wrap items-start gap-2 rounded-xl bg-surface-2 p-3"
          >
            <div className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
              <p className="text-sm font-semibold">{item.title}</p>
              <p className="whitespace-pre-wrap text-sm text-muted">
                {item.text}
              </p>
            </div>
            {canEdit ? (
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('replies.up', { title: item.title })}
                  disabled={index === 0 || move.isPending}
                  onClick={() => swap(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('replies.down', { title: item.title })}
                  disabled={index === list.items.length - 1 || move.isPending}
                  onClick={() => swap(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  icon="pencil"
                  data-testid="reply-edit"
                  onClick={() => {
                    setEditing(item);
                    setTitle(item.title);
                    setText(item.text);
                  }}
                >
                  {t('replies.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  data-testid="reply-delete"
                  aria-label={t('replies.deleteOne', { title: item.title })}
                  onClick={() => setDeleteId(item.id)}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={target !== null && target !== undefined}
        title={t('replies.deleteTitle')}
        body={t('replies.deleteBody', { title: target?.title ?? '' })}
        confirmLabel={t('replies.deleteConfirm')}
        cancelLabel={t('app.cancel')}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => deleteId && remove.mutate(deleteId)}
        onCancel={() => setDeleteId(null)}
      />
    </Section>
  );
}
