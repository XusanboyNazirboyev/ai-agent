'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ChannelAccount } from '@/lib/types';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

/** Comma or new line separated words, trimmed, without repeats, at most 20. */
export function keywordsFromText(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/u)
        .map((word) => word.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

/**
 * Owner 2026-11-24 (Channels, first content-creator feature): the AI answers
 * Instagram comments that ask something, in a private message, with a short
 * public reply under the comment (ADR 043). Off until the owner turns it on.
 */
export function CommentRepliesCard(props: {
  account: ChannelAccount;
  canManage: boolean;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(props.account.commentReplies ?? false);
  const [words, setWords] = useState(
    (props.account.commentKeywords ?? []).join(', '),
  );
  useEffect(() => {
    setEnabled(props.account.commentReplies ?? false);
    setWords((props.account.commentKeywords ?? []).join(', '));
  }, [props.account.commentReplies, props.account.commentKeywords]);
  const save = useMutation({
    mutationFn: () =>
      api<ChannelAccount>(
        `/api/v1/channels/instagram/${props.account.id}/comment-replies`,
        {
          method: 'PUT',
          body: { enabled, keywords: keywordsFromText(words) },
        },
      ),
    onSuccess: () => {
      toast(t('comments.saved'));
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
  return (
    <section
      data-testid={`comment-replies-${props.account.id}`}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 font-semibold">
          <Icon name="message" className="h-4 w-4 text-muted" />
          {t('comments.title')}
          {props.account.displayName ? (
            <span className="text-sm font-normal text-muted">
              {props.account.displayName}
            </span>
          ) : null}
        </h3>
        <p className="text-sm text-muted">{t('comments.intro')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!props.canManage}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="comment-replies-toggle"
          className="h-4 w-4"
        />
        {t('comments.enable')}
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t('comments.keywords')}
        <input
          value={words}
          disabled={!props.canManage}
          onChange={(e) => setWords(e.target.value)}
          placeholder={t('comments.keywordsHint')}
          data-testid="comment-replies-words"
          className={fieldClass}
        />
        <span className="text-xs font-normal text-muted">
          {t('comments.keywordsNote')}
        </span>
      </label>
      <p className="text-xs text-muted">{t('comments.permissionNote')}</p>
      {save.isError ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          {t(errorKey(save.error))}
        </p>
      ) : null}
      {props.canManage ? (
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() => save.mutate()}
          data-testid="comment-replies-save"
          className="self-start"
        >
          {t('profile.save')}
        </Button>
      ) : null}
    </section>
  );
}
