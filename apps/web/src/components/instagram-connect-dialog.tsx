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

/** The API accepts 20 to 2,048 non-space characters (instagram-connect.controller.ts). */
const TOKEN_MAX = 2_048;

/**
 * Pastes an Instagram User access token (generated in the Meta App Dashboard
 * for an account with a role on the app). The token goes to the server once
 * and is never shown again; enabling subscribes the account to direct
 * messages at Meta.
 */
export function InstagramConnectDialog(props: {
  open: boolean;
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
      api<ChannelAccount>('/api/v1/channels/instagram', {
        method: 'POST',
        body: { accessToken: token.trim() },
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
      api<ChannelAccount>(`/api/v1/channels/instagram/${id}/enable`, {
        method: 'POST',
      }),
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
      data-testid="instagram-connect-dialog"
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
          {t('igConnect.title')}
        </h2>
        {connected ? (
          <>
            <p
              role="status"
              data-testid="ig-connect-done"
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
            <p className="text-sm text-muted">{t('igConnect.doneNext')}</p>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted">
              <li>{t('igConnect.step1')}</li>
              <li>{t('igConnect.step2')}</li>
              <li>{t('igConnect.step3')}</li>
            </ol>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              {t('igConnect.token')}
              <input
                type="password"
                data-testid="ig-connect-token"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                required
                maxLength={TOKEN_MAX}
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
            data-testid="ig-connect-error"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(failure))}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {connected ? (
            <>
              <Button onClick={props.onClose} data-testid="ig-connect-later">
                {t('connect.later')}
              </Button>
              <Button
                variant="primary"
                loading={enable.isPending}
                data-testid="ig-connect-enable"
                onClick={() => enable.mutate(connected.id)}
              >
                {t('connect.enableNow')}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={props.onClose} data-testid="ig-connect-cancel">
                {t('confirm.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={connect.isPending}
                disabled={!token.trim()}
                data-testid="ig-connect-submit"
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
