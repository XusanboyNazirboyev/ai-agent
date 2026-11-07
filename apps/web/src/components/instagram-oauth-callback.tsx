'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ChannelAccount } from '@/lib/types';
import { Button, buttonClass } from './ui/button';
import { Icon } from './ui/icons';

/**
 * Where Instagram sends the browser back after Business Login. The page posts
 * `code` and `state` to the API from this session (the session cookie is not
 * sent with Instagram's redirect itself) and drops both from the address bar
 * at once, because the code is single-use.
 */
export function InstagramOAuthCallback(): ReactNode {
  const { t } = useI18n();
  const params = useSearchParams();
  const [initial] = useState(() => ({
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
  }));
  const sent = useRef(false);
  const complete = useMutation({
    mutationFn: (body: { code: string; state: string }) =>
      api<ChannelAccount>('/api/v1/channels/instagram/oauth/complete', {
        method: 'POST',
        body,
      }),
  });
  const enable = useMutation({
    mutationFn: (id: string) =>
      api<ChannelAccount>(`/api/v1/channels/instagram/${id}/enable`, {
        method: 'POST',
      }),
  });
  const { mutate } = complete;

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
    if (sent.current || initial.error || !initial.code || !initial.state)
      return;
    sent.current = true;
    mutate({ code: initial.code, state: initial.state });
  }, [initial, mutate]);

  const denied = initial.error !== null;
  const missing = !denied && (!initial.code || !initial.state);
  const account = complete.data;
  const failure = complete.error ?? enable.error;

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('igCallback.title')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-3 sm:p-6">
        <h1 className="text-lg font-semibold">{t('igCallback.title')}</h1>
        {denied || missing ? (
          <p
            role="alert"
            data-testid="ig-callback-denied"
            className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm"
          >
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(denied ? 'igCallback.denied' : 'igCallback.invalid')}
          </p>
        ) : null}
        {complete.isPending ? (
          <p role="status" className="text-sm text-muted">
            {t('igCallback.working')}
          </p>
        ) : null}
        {account ? (
          <>
            <p
              role="status"
              data-testid="ig-callback-done"
              className="flex items-start gap-2 font-medium"
            >
              <Icon
                name="check"
                className="mt-0.5 h-4 w-4 shrink-0 text-success-fg"
              />
              {t('connect.done', {
                name: account.displayName ?? t('channels.connect'),
              })}
            </p>
            {enable.isSuccess ? (
              <p
                role="status"
                data-testid="ig-callback-enabled"
                className="text-sm"
              >
                {t('igCallback.enabled')}
              </p>
            ) : (
              <p className="text-sm text-muted">{t('igConnect.doneNext')}</p>
            )}
          </>
        ) : null}
        {failure ? (
          <p
            role="alert"
            data-testid="ig-callback-error"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(failure))}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {account && !enable.isSuccess ? (
            <Button
              variant="primary"
              loading={enable.isPending}
              data-testid="ig-callback-enable"
              onClick={() => enable.mutate(account.id)}
            >
              {t('connect.enableNow')}
            </Button>
          ) : null}
          <Link
            href="/settings/channels"
            data-testid="ig-callback-back"
            className={buttonClass()}
          >
            {t('igCallback.back')}
          </Link>
        </div>
      </div>
    </div>
  );
}
