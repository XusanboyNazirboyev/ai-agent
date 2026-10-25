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
import type { ChannelAccount } from '@/lib/types';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';

/** What a bot token looks like (an example, not a real token). */
const TOKEN_EXAMPLE = '123456789:AAH…';

/**
 * Pastes a bot token. The token goes to the server once and is never shown
 * again; after a successful connection the account can be enabled right away
 * (the webhook is then registered with Telegram).
 */
export function TelegramConnectDialog(props: {
  open: boolean;
  replacing: boolean;
  canEnable: boolean;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState<ChannelAccount | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setToken('');
      setConnected(null);
      dialog.showModal();
    }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  const connect = useMutation({
    mutationFn: () =>
      api<ChannelAccount>('/api/v1/channels/telegram', {
        method: 'POST',
        body: { botToken: token.trim() },
      }),
    onSuccess: (account) => {
      // The token is not kept in memory a moment longer than needed.
      setToken('');
      setConnected(account);
      props.onChanged();
    },
  });
  const enable = useMutation({
    mutationFn: (id: string) =>
      api<ChannelAccount>(`/api/v1/channels/${id}/enable`, { method: 'POST' }),
    onSuccess: () => {
      props.onChanged();
      props.onClose();
    },
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (token.trim() && !connect.isPending) connect.mutate();
  }
  const failure = connect.error ?? enable.error;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="telegram-connect-dialog"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onClose();
      }}
      className="m-auto max-h-[92dvh] w-[min(94vw,34rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-lg font-semibold">
          {props.replacing ? t('connect.titleReplace') : t('connect.title')}
        </h2>
        {connected ? (
          <>
            <p
              role="status"
              data-testid="connect-done"
              className="flex items-start gap-2 font-medium"
            >
              <Icon
                name="check"
                className="mt-0.5 h-4 w-4 shrink-0 text-success-fg"
              />
              {t('connect.done', {
                name: connected.displayName ?? t('channels.connect'),
              })}
            </p>
            <p className="text-sm text-muted">{t('connect.doneNext')}</p>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted">
              <li>{t('connect.step1')}</li>
              <li>{t('connect.step2')}</li>
              <li>{t('connect.step3')}</li>
            </ol>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              {t('connect.token')}
              <input
                type="password"
                data-testid="connect-token"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                required
                maxLength={200}
                placeholder={TOKEN_EXAMPLE}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className={fieldClass}
              />
            </label>
          </form>
        )}
        {failure ? (
          <p
            role="alert"
            data-testid="connect-error"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(failure))}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {connected ? (
            <>
              <Button onClick={props.onClose} data-testid="connect-later">
                {t('connect.later')}
              </Button>
              {props.canEnable ? (
                <Button
                  variant="primary"
                  loading={enable.isPending}
                  data-testid="connect-enable"
                  onClick={() => enable.mutate(connected.id)}
                >
                  {t('connect.enableNow')}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button onClick={props.onClose} data-testid="connect-cancel">
                {t('confirm.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={connect.isPending}
                disabled={!token.trim()}
                data-testid="connect-submit"
                onClick={() => {
                  if (token.trim() && !connect.isPending) connect.mutate();
                }}
              >
                {connect.isPending
                  ? t('connect.submitting')
                  : t('connect.submit')}
              </Button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
