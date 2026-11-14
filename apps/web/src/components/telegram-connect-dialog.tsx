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
import { looksLikeBotToken } from '@/lib/telegram-token';
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
            <BotFatherGuide />
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
              {token.trim() && !looksLikeBotToken(token) ? (
                <span
                  data-testid="connect-token-hint"
                  className="flex items-start gap-1.5 text-xs font-normal text-warning-fg"
                >
                  <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t('connect.tokenHint')}
                </span>
              ) : null}
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

/**
 * The four steps to get a bot token, each with a small picture of what the
 * admin will see in Telegram (drawn here, not screenshots: Telegram's look
 * changes). Nothing in the pictures is a real bot or token.
 */
function BotFatherGuide(): ReactNode {
  const { t } = useI18n();
  return (
    <ol className="flex flex-col gap-3" data-testid="botfather-guide">
      <Step n={1} title={t('connect.s1.title')} hint={t('connect.s1.hint')}>
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1 text-sm"
          >
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            @BotFather
            <Icon name="check" className="h-3.5 w-3.5 text-primary-fg" />
          </span>
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="botfather-link"
            className="inline-flex min-h-9 items-center rounded-lg border border-line px-3 text-sm font-medium text-primary-fg hover:bg-surface-2"
          >
            {t('connect.s1.open')}
          </a>
        </div>
      </Step>
      <Step n={2} title={t('connect.s2.title')} hint={t('connect.s2.hint')}>
        <div aria-hidden="true" className="flex flex-col gap-1.5 text-sm">
          <span className="self-end rounded-2xl rounded-br-md bg-primary px-3 py-1 text-white">
            /newbot
          </span>
          <span className="self-start rounded-2xl rounded-bl-md border border-line bg-surface-2 px-3 py-1 text-muted">
            {t('connect.s2.nameExample')}
          </span>
          <span className="self-end rounded-2xl rounded-br-md bg-primary px-3 py-1 text-white">
            {t('connect.s2.usernameExample')}
          </span>
        </div>
      </Step>
      <Step n={3} title={t('connect.s3.title')} hint={t('connect.s3.hint')}>
        <div
          aria-hidden="true"
          className="rounded-2xl rounded-bl-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm break-all"
        >
          <span className="text-muted">123456789</span>
          <span className="font-bold text-primary-fg">:</span>
          <span>AAH…</span>
        </div>
        <p className="text-xs text-muted">{t('connect.s3.have')}</p>
      </Step>
      <Step n={4} title={t('connect.s4.title')} hint={t('connect.s4.hint')} />
    </ol>
  );
}

function Step(props: {
  n: number;
  title: string;
  hint: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary-fg"
      >
        {props.n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="font-medium">{props.title}</p>
        <p className="text-sm text-muted">{props.hint}</p>
        {props.children}
      </div>
    </li>
  );
}
