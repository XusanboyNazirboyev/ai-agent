'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ConnectorList, ConnectorSummary } from '@/lib/types';
import { useShell } from './app-shell';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

/** What an incoming-webhook address looks like (an example, not a real one). */
const URL_EXAMPLE = 'https://your-portal.bitrix24.ru/rest/1/…/';

/** Product names are not translated. */
const SOON = ['amoCRM', 'HubSpot'];

function Card(props: {
  name: string;
  badge: ReactNode;
  testId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      data-testid={props.testId}
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 font-semibold break-words">{props.name}</h2>
        {props.badge}
      </div>
      {props.children}
    </section>
  );
}

function Bitrix24Card(props: {
  row: ConnectorSummary | undefined;
  secretsConfigured: boolean;
  onChanged: () => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const active = props.row?.status === 'ACTIVE' && props.row.configured;
  const showForm = !active || editing;

  const connect = useMutation({
    mutationFn: () =>
      api<ConnectorSummary>('/api/v1/connectors/bitrix24', {
        method: 'POST',
        body: { webhookUrl: url.trim() },
      }),
    onSuccess: () => {
      // The address is not kept in memory a moment longer than needed.
      setUrl('');
      setEditing(false);
      toast(t('toast.crmConnected'));
      props.onChanged();
    },
  });
  const act = useMutation({
    mutationFn: (step: 'disable' | 'disconnect') =>
      step === 'disable'
        ? api(`/api/v1/connectors/${props.row!.id}/disable`, { method: 'POST' })
        : api(`/api/v1/connectors/${props.row!.id}`, { method: 'DELETE' }),
    onSuccess: (_result, step) => {
      setDisconnecting(false);
      toast(
        t(step === 'disable' ? 'toast.crmDisabled' : 'toast.crmDisconnected'),
      );
      props.onChanged();
    },
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (url.trim() && !connect.isPending) connect.mutate();
  }
  const failure = connect.error ?? act.error;
  const badge = active ? (
    <Badge tone="success">{t('crm.active')}</Badge>
  ) : props.row?.status === 'DISABLED' && props.row.configured ? (
    <Badge tone="warning">{t('crm.disabled')}</Badge>
  ) : (
    <Badge tone="neutral">{t('crm.notConnected')}</Badge>
  );

  return (
    <Card name="Bitrix24" badge={badge} testId="crm-bitrix24">
      <p className="text-sm text-muted">{t('crm.bitrix.desc')}</p>
      {showForm ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted">
            <li>{t('crm.bitrix.step1')}</li>
            <li className="break-words">
              {t('crm.bitrix.step2', { example: URL_EXAMPLE })}
            </li>
            <li>{t('crm.bitrix.step3')}</li>
          </ol>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            {t('crm.bitrix.url')}
            <input
              type="password"
              data-testid="crm-webhook-url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              maxLength={500}
              placeholder={URL_EXAMPLE}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={!props.secretsConfigured}
              className={fieldClass}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            {editing ? (
              <Button
                onClick={() => {
                  setEditing(false);
                  setUrl('');
                }}
              >
                {t('confirm.cancel')}
              </Button>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              loading={connect.isPending}
              disabled={!url.trim() || !props.secretsConfigured}
              data-testid="crm-connect"
            >
              {connect.isPending
                ? t('crm.bitrix.connecting')
                : t('crm.bitrix.connect')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing(true)} data-testid="crm-replace">
            {t('crm.bitrix.replace')}
          </Button>
          <Button
            onClick={() => act.mutate('disable')}
            disabled={act.isPending}
            data-testid="crm-disable"
          >
            {t('crm.bitrix.disable')}
          </Button>
          <Button
            variant="danger"
            onClick={() => setDisconnecting(true)}
            data-testid="crm-disconnect"
          >
            {t('crm.bitrix.disconnect')}
          </Button>
        </div>
      )}
      {failure ? (
        <p
          role="alert"
          data-testid="crm-error"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{t(errorKey(failure))}</span>
        </p>
      ) : null}
      <ConfirmDialog
        open={disconnecting}
        title={t('crm.disconnectTitle')}
        body={t('crm.disconnectBody')}
        confirmLabel={t('crm.bitrix.disconnect')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={act.isPending}
        onConfirm={() => act.mutate('disconnect')}
        onCancel={() => setDisconnecting(false)}
      />
    </Card>
  );
}

/** Connect a CRM as the lead sink (ADR 032; slice 1: Bitrix24). */
export function CrmPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const queryClient = useQueryClient();
  const canManage = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const query = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api<ConnectorList>('/api/v1/connectors'),
    enabled: canManage,
  });
  const bitrix = query.data?.items.find(
    (item) => item.connectorKey === 'bitrix24',
  );
  const changed = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['connectors'] });
  };

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.crm')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('crm.intro')}</p>
        {!canManage ? (
          <p
            role="status"
            data-testid="crm-admin-only"
            className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm"
          >
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('crm.adminOnly')}
          </p>
        ) : null}
        {query.isSuccess && !query.data.secretsConfigured ? (
          <p
            role="status"
            data-testid="crm-needs-secrets"
            className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{t('crm.needSecrets')}</span>
          </p>
        ) : null}
        {query.isPending && canManage ? (
          <div
            role="status"
            className="overflow-hidden rounded-2xl border border-line bg-surface"
          >
            <span className="sr-only">{t('app.loading')}</span>
            <SkeletonRows rows={2} />
          </div>
        ) : null}
        {query.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
            >
              <Icon name="alert" />
              {t(errorKey(query.error))}
            </p>
            <Button size="sm" onClick={() => void query.refetch()}>
              {t('app.retry')}
            </Button>
          </div>
        ) : null}
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          {query.isSuccess ? (
            <Bitrix24Card
              row={bitrix}
              secretsConfigured={query.data.secretsConfigured}
              onChanged={changed}
            />
          ) : null}
          <Card
            name={t('crm.internal.name')}
            badge={<Badge tone="success">{t('crm.active')}</Badge>}
            testId="crm-internal"
          >
            <p className="text-sm text-muted">{t('crm.internal.desc')}</p>
          </Card>
          {SOON.map((name) => (
            <Card
              key={name}
              name={name}
              badge={<Badge tone="neutral">{t('crm.soon')}</Badge>}
              testId={`crm-soon-${name.toLowerCase()}`}
            >
              <p className="text-sm text-muted">{t('crm.soonDesc')}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
