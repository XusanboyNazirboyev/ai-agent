'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { canManageTeam } from '@/lib/roles';
import { useShell } from './app-shell';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

export interface TelephonyStatus {
  minutesLimit: number;
  secretsConfigured: boolean;
  account: {
    provider: 'ONLINEPBX';
    domain: string;
    enabled: boolean;
    connected: boolean;
    lastError: string | null;
    polledUntil: string | null;
  } | null;
}

/**
 * Owner 2026-11-24: calls belong in the CRM section; connecting OnlinePBX
 * (ADR 085) lives in Settings > Integrations (`settings`), the CRM tab only
 * shows the state and links there. The per-call summary and next step come
 * on the lead card once the analysis step ships.
 */
export function CallsPage(props: { settings?: boolean }): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { operator } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const manager = canManageTeam(operator.role);
  const status = useQuery({
    queryKey: ['telephony'],
    queryFn: () => api<TelephonyStatus>('/api/v1/telephony'),
    enabled: manager,
  });
  const [domain, setDomain] = useState('');
  const [apiKey, setApiKey] = useState('');
  const connect = useMutation({
    mutationFn: () =>
      api<TelephonyStatus>('/api/v1/telephony/onlinepbx', {
        method: 'POST',
        body: { domain, apiKey },
      }),
    onSuccess: (next) => {
      setApiKey('');
      qc.setQueryData(['telephony'], next);
      toast(t('calls.connected'));
    },
  });
  const disconnect = useMutation({
    mutationFn: () =>
      api<TelephonyStatus>('/api/v1/telephony/onlinepbx', {
        method: 'DELETE',
      }),
    onSuccess: (next) => qc.setQueryData(['telephony'], next),
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (domain.trim() && apiKey.trim()) connect.mutate();
  }
  const data = status.data;
  const account = data?.account?.connected ? data.account : null;
  const error = connect.error ?? disconnect.error;
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('crm.tab.calls')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('calls.intro')}</p>
        {!manager ? (
          <p role="status" className="text-sm text-muted">
            {t('team.managersOnly')}
          </p>
        ) : null}
        {data && data.minutesLimit <= 0 ? (
          <section
            data-testid="calls-plan"
            className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 sm:p-5"
          >
            <h2 className="font-semibold">{t('calls.planTitle')}</h2>
            <p className="text-sm text-muted">{t('calls.planBody')}</p>
            <Link href="/billing" className="self-start text-sm underline">
              {t('nav.billing')}
            </Link>
          </section>
        ) : null}
        {data && data.minutesLimit > 0 ? (
          <section
            data-testid="calls-pbx"
            className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
          >
            <h2 className="flex items-center gap-2 font-semibold">
              <Icon name="phone" className="h-5 w-5 text-muted" />
              OnlinePBX
            </h2>
            <p className="text-sm text-muted">
              {t('calls.minutes', { minutes: data.minutesLimit })}
            </p>
            {account ? (
              <>
                <dl className="grid gap-1 text-sm">
                  <dt className="text-muted">{t('calls.domain')}</dt>
                  <dd data-testid="calls-domain">{account.domain}</dd>
                  {account.polledUntil ? (
                    <>
                      <dt className="text-muted">{t('calls.checked')}</dt>
                      <dd>{formatDateTime(account.polledUntil)}</dd>
                    </>
                  ) : null}
                </dl>
                {account.lastError ? (
                  <p role="alert" className="text-sm text-danger-fg">
                    {t('calls.lastError')}
                  </p>
                ) : null}
                {props.settings ? (
                  <Button
                    variant="secondary"
                    loading={disconnect.isPending}
                    onClick={() => disconnect.mutate()}
                    data-testid="calls-disconnect"
                    className="self-start"
                  >
                    {t('calls.disconnect')}
                  </Button>
                ) : null}
              </>
            ) : !props.settings ? (
              <Link
                href="/settings/telephony"
                data-testid="calls-connect-link"
                className="self-start text-sm underline"
              >
                {t('calls.connectInSettings')}
              </Link>
            ) : (
              <form
                onSubmit={submit}
                className="flex flex-col gap-3"
                noValidate
              >
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  {t('calls.domain')}
                  <input
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder={t('calls.domainExample')}
                    autoComplete="off"
                    data-testid="calls-domain-input"
                    className={fieldClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  {t('calls.apiKey')}
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                    data-testid="calls-key-input"
                    className={fieldClass}
                  />
                  <span className="text-xs font-normal text-muted">
                    {t('calls.keyHint')}
                  </span>
                </label>
                <Button
                  type="submit"
                  variant="primary"
                  loading={connect.isPending}
                  disabled={!domain.trim() || !apiKey.trim()}
                  data-testid="calls-connect"
                  className="self-start"
                >
                  {t('calls.connect')}
                </Button>
              </form>
            )}
            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
              >
                <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                {t(errorKey(error))}
              </p>
            ) : null}
          </section>
        ) : null}
        <p className="text-sm text-muted" data-testid="calls-soon">
          {t('calls.soon')}
        </p>
      </div>
    </div>
  );
}
