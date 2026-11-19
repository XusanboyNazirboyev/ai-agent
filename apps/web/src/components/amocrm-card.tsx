'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { AmocrmPipelineView, ConnectorSummary } from '@/lib/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './crm-card';
import { ConfirmDialog } from './ui/confirm-dialog';
import { CrmStageSync } from './crm-stage-sync';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Select } from './ui/select';
import { useToast } from './ui/toast';

/** What the address bar looks like (an example, not a real account). */
const ADDRESS_EXAMPLE = 'your-company.amocrm.ru';
const SUBDOMAIN_EXAMPLE = 'your-company';

/** Connect amoCRM as a lead sink and follow its stages (ADR 081). */
export function AmocrmCard(props: {
  row: ConnectorSummary | undefined;
  secretsConfigured: boolean;
  onChanged: () => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [subdomain, setSubdomain] = useState('');
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const active = props.row?.status === 'ACTIVE' && props.row.configured;
  const showForm = !active || editing;
  const pipelinesKey = ['connectors', 'amocrm-pipelines', props.row?.id];

  const pipelines = useQuery({
    queryKey: pipelinesKey,
    queryFn: () =>
      api<AmocrmPipelineView>(
        `/api/v1/connectors/${props.row!.id}/amocrm/pipelines`,
      ),
    enabled: active && !editing,
  });
  const choose = useMutation({
    mutationFn: (pipelineId: number) =>
      api<AmocrmPipelineView>(
        `/api/v1/connectors/${props.row!.id}/amocrm/pipeline`,
        { method: 'PUT', body: { pipelineId } },
      ),
    onSuccess: (view) => {
      client.setQueryData(pipelinesKey, view);
      // The stage list belongs to the chosen pipeline.
      void client.invalidateQueries({
        queryKey: ['connectors', 'stage-sync', props.row!.id],
      });
      toast(t('amocrm.pipelineSaved'));
    },
  });
  const connect = useMutation({
    mutationFn: () =>
      api<ConnectorSummary>('/api/v1/connectors/amocrm', {
        method: 'POST',
        body: { subdomain: subdomain.trim(), token: token.trim() },
      }),
    onSuccess: () => {
      // The token is not kept in memory a moment longer than needed.
      setToken('');
      setSubdomain('');
      setEditing(false);
      toast(t('amocrm.toast.connected'));
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
        t(
          step === 'disable'
            ? 'amocrm.toast.disabled'
            : 'amocrm.toast.disconnected',
        ),
      );
      props.onChanged();
    },
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (subdomain.trim() && token.trim() && !connect.isPending)
      connect.mutate();
  }
  const failure = connect.error ?? act.error ?? choose.error;
  const badge = active ? (
    <Badge tone="success">{t('crm.active')}</Badge>
  ) : props.row?.status === 'DISABLED' && props.row.configured ? (
    <Badge tone="warning">{t('crm.disabled')}</Badge>
  ) : (
    <Badge tone="neutral">{t('crm.notConnected')}</Badge>
  );

  return (
    <Card name="amoCRM" badge={badge} testId="crm-amocrm">
      <p className="text-sm text-muted">{t('amocrm.desc')}</p>
      {showForm ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted">
            <li>{t('amocrm.step1')}</li>
            <li>{t('amocrm.step2')}</li>
            <li className="break-words">
              {t('amocrm.step3', { example: ADDRESS_EXAMPLE })}
            </li>
          </ol>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            {t('amocrm.subdomain')}
            <input
              type="text"
              data-testid="amocrm-subdomain"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              maxLength={63}
              placeholder={SUBDOMAIN_EXAMPLE}
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              disabled={!props.secretsConfigured}
              className={fieldClass}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            {t('amocrm.token')}
            <input
              type="password"
              data-testid="amocrm-token"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              maxLength={4000}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={!props.secretsConfigured}
              className={fieldClass}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            {editing ? (
              <Button
                onClick={() => {
                  setEditing(false);
                  setToken('');
                  setSubdomain('');
                }}
              >
                {t('confirm.cancel')}
              </Button>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              loading={connect.isPending}
              disabled={
                !subdomain.trim() || !token.trim() || !props.secretsConfigured
              }
              data-testid="amocrm-connect"
            >
              {connect.isPending ? t('amocrm.connecting') : t('amocrm.connect')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing(true)} data-testid="amocrm-replace">
            {t('amocrm.replace')}
          </Button>
          <Button
            onClick={() => act.mutate('disable')}
            disabled={act.isPending}
            data-testid="amocrm-disable"
          >
            {t('amocrm.disable')}
          </Button>
          <Button
            variant="danger"
            onClick={() => setDisconnecting(true)}
            data-testid="amocrm-disconnect"
          >
            {t('amocrm.disconnect')}
          </Button>
        </div>
      )}
      {active && !editing && props.row ? (
        <div
          className="flex min-w-0 flex-col gap-2 border-t border-line pt-3"
          data-testid="amocrm-pipeline"
        >
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            {t('amocrm.pipeline')}
            <Select
              data-testid="amocrm-pipeline-select"
              value={pipelines.data?.pipelineId?.toString() ?? ''}
              disabled={!pipelines.data || choose.isPending}
              onChange={(event) => {
                if (event.target.value)
                  choose.mutate(Number(event.target.value));
              }}
            >
              <option value="">{t('amocrm.pipelineChoose')}</option>
              {pipelines.data?.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          <p className="text-sm text-muted">{t('amocrm.pipelineHint')}</p>
          {pipelines.isError ? (
            <p role="alert" className="text-sm text-danger-fg">
              {t(errorKey(pipelines.error))}
            </p>
          ) : null}
        </div>
      ) : null}
      {active && !editing && props.row ? (
        <CrmStageSync connectorId={props.row.id} provider="amocrm" />
      ) : null}
      {failure ? (
        <p
          role="alert"
          data-testid="amocrm-error"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{t(errorKey(failure))}</span>
        </p>
      ) : null}
      <ConfirmDialog
        open={disconnecting}
        title={t('amocrm.disconnectTitle')}
        body={t('amocrm.disconnectBody')}
        confirmLabel={t('amocrm.disconnect')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={act.isPending}
        onConfirm={() => act.mutate('disconnect')}
        onCancel={() => setDisconnecting(false)}
      />
    </Card>
  );
}
