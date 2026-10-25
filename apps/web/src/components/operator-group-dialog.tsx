'use client';

import { useMutation } from '@tanstack/react-query';
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
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

/** Sets or clears the Telegram group where handovers are posted. */
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
  const open = props.accountId !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setChatId('');
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

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (chatId.trim() && !save.isPending) save.mutate(chatId.trim());
  }

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
        <label className="flex flex-col gap-1.5 text-sm font-medium">
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
        {save.error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(save.error))}
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
            variant="primary"
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
