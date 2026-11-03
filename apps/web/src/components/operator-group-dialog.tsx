'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ChannelList } from '@/lib/types';
import { Button, buttonClass } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

/**
 * Sets or clears the Telegram group where handovers are posted. The usual
 * way is one click (ADR 036): a t.me link lets the operator pick the group
 * in Telegram, and this dialog waits until the server reports it linked.
 * Entering the chat id by hand stays available.
 */
export function OperatorGroupDialog(props: {
  accountId: string | null;
  configured: boolean;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [chatId, setChatId] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const open = props.accountId !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setChatId('');
      setLink(null);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const save = useMutation({
    mutationFn: (value: string | null) =>
      api(`/api/v1/channels/${props.accountId}/operator-group`, {
        method: 'PUT',
        body: { chatId: value },
      }),
    onSuccess: () => {
      toast(t('toast.groupSaved'));
      props.onChanged();
      props.onClose();
    },
  });

  const createLink = useMutation({
    mutationFn: () =>
      api<{ url: string; expiresAt: string }>(
        `/api/v1/channels/${props.accountId}/operator-group/link`,
        { method: 'POST' },
      ),
    onSuccess: (result) => setLink(result.url),
  });

  // While the link is out, watch for the group to arrive (a new group only;
  // moving an existing one is confirmed by the bot's message in Telegram).
  const waiting = open && link !== null && !props.configured;
  const watch = useQuery({
    queryKey: ['channels'],
    queryFn: () => api<ChannelList>('/api/v1/channels'),
    enabled: waiting,
    refetchInterval: waiting ? 3_000 : false,
  });
  const linked =
    waiting &&
    (watch.data?.items.find((item) => item.id === props.accountId)
      ?.operatorGroupConfigured ??
      false);
  useEffect(() => {
    if (!linked) return;
    toast(t('toast.groupSaved'));
    props.onChanged();
    props.onClose();
  }, [linked]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (chatId.trim() && !save.isPending) save.mutate(chatId.trim());
  }

  const error = createLink.error ?? save.error;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="operator-group-dialog"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onClose();
      }}
      className="m-auto w-[min(94vw,30rem)] rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-lg font-semibold">
          {t('group.title')}
        </h2>
        <p className="text-sm text-muted">{t('group.hint')}</p>

        <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <p className="text-sm">{t('group.oneClickHint')}</p>
          {link === null ? (
            <Button
              variant="primary"
              loading={createLink.isPending}
              data-testid="group-link-create"
              onClick={() => createLink.mutate()}
            >
              {t('group.oneClick')}
            </Button>
          ) : (
            <>
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="group-link-open"
                className={buttonClass('primary')}
              >
                {t('group.open')}
              </a>
              <p className="text-sm text-muted" role="status">
                {props.configured ? t('group.waitingMove') : t('group.waiting')}
              </p>
            </>
          )}
        </div>

        <details className="text-sm">
          <summary
            className="cursor-pointer text-muted"
            data-testid="group-manual"
          >
            {t('group.manual')}
          </summary>
          <label className="mt-2 flex flex-col gap-1.5 font-medium">
            {t('group.id')}
            <input
              data-testid="group-chat-id"
              inputMode="numeric"
              autoComplete="off"
              maxLength={22}
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              className={fieldClass}
            />
          </label>
        </details>

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(error))}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {props.configured ? (
            <Button
              variant="danger"
              disabled={save.isPending}
              data-testid="group-remove"
              onClick={() => save.mutate(null)}
            >
              {t('group.remove')}
            </Button>
          ) : null}
          <Button onClick={props.onClose}>{t('confirm.cancel')}</Button>
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!chatId.trim()}
            data-testid="group-save"
          >
            {t('group.save')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
