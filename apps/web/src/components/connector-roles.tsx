'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ConnectorSummary } from '@/lib/types';
import { useShell } from './app-shell';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { useToast } from './ui/toast';

export type ConnectorRole = 'CATALOG' | 'LEAD_SINK' | 'ACTIONS';

export interface ConnectorRoleItem {
  role: ConnectorRole;
  tenantConnectorId: string | null;
  connectorKey: string | null;
  status: 'BOUND' | 'UNBOUND' | 'AMBIGUOUS' | 'UNAVAILABLE';
}

const ROLES: ConnectorRole[] = ['CATALOG', 'LEAD_SINK', 'ACTIONS'];

const STATUS_TONE: Record<ConnectorRoleItem['status'], Tone> = {
  BOUND: 'success',
  UNBOUND: 'neutral',
  AMBIGUOUS: 'warning',
  UNAVAILABLE: 'danger',
};

const ROLE_I18N: Record<ConnectorRole, { label: string; desc: string }> = {
  CATALOG: {
    label: 'connectorRoles.role.CATALOG',
    desc: 'connectorRoles.desc.CATALOG',
  },
  LEAD_SINK: {
    label: 'connectorRoles.role.LEAD_SINK',
    desc: 'connectorRoles.desc.LEAD_SINK',
  },
  ACTIONS: {
    label: 'connectorRoles.role.ACTIONS',
    desc: 'connectorRoles.desc.ACTIONS',
  },
};

function ConnectorRoleRow(props: {
  role: ConnectorRole;
  item: ConnectorRoleItem;
  connectors: ConnectorSummary[];
  onSaved: () => void;
}): ReactNode {
  const { t } = useI18n();
  const notify = useToast();
  const { label, desc } = ROLE_I18N[props.role];
  const activeConnectors = props.connectors.filter(
    (c) => c.status === 'ACTIVE',
  );
  const boundConnector = props.connectors.find(
    (c) => c.id === props.item.tenantConnectorId,
  );
  const [error, setError] = useState<string | undefined>();

  const bind = useMutation({
    mutationFn: (tenantConnectorId: string | null) =>
      api<ConnectorRoleItem>('/api/v1/connectors/roles', {
        method: 'PUT',
        body: { role: props.role, tenantConnectorId },
      }),
    onMutate: () => setError(undefined),
    onError: (failure) => setError(errorKey(failure)),
    onSuccess: () => {
      notify(t('connectorRoles.save'));
      props.onSaved();
    },
  });

  return (
    <section
      data-testid={`connector-role-${props.role}`}
      className="flex min-w-0 flex-wrap items-start gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-semibold">{t(label)}</span>
        <span className="text-xs text-muted break-words">{t(desc)}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge
          tone={STATUS_TONE[props.item.status]}
          data-testid={`connector-role-badge-${props.role}`}
        >
          {t(`connectorRoles.status.${props.item.status}`)}
        </Badge>
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium sr-only">
          {t('connectorRoles.activeConnectors')}
          <Select
            aria-label={t('connectorRoles.activeConnectors')}
            data-testid={`connector-role-select-${props.role}`}
            value={
              props.item.tenantConnectorId ?? boundConnector?.connectorKey ?? ''
            }
            onChange={(event) => {
              const value = event.target.value;
              bind.mutate(value === '' ? null : value);
            }}
            disabled={bind.isPending}
            className="min-w-0 max-w-xs"
          >
            <option value="">{t('connectorRoles.notChosen')}</option>
            {activeConnectors.map((connector) => (
              <option key={connector.id} value={connector.id}>
                {connector.connectorKey}
              </option>
            ))}
          </Select>
        </label>
        {error ? (
          <p
            role="alert"
            data-testid={`connector-role-error-${props.role}`}
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <span className="min-w-0 break-words">{t(error)}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function ConnectorRoles(props: {
  connectors: ConnectorSummary[];
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const canManage = operator.role === 'OWNER' || operator.role === 'ADMIN';

  const roles = useQuery({
    queryKey: ['connectors', 'roles'],
    queryFn: () =>
      api<{ items: ConnectorRoleItem[] }>('/api/v1/connectors/roles'),
    enabled: canManage,
  });

  if (!canManage) return null;

  return (
    <section
      data-testid="connector-roles-section"
      className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <h2 className="text-sm font-semibold">{t('connectorRoles.title')}</h2>
      {roles.isPending ? (
        <div
          role="status"
          className="overflow-hidden rounded-2xl border border-line bg-surface"
        >
          <span className="sr-only">{t('app.loading')}</span>
        </div>
      ) : null}
      {roles.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <span className="min-w-0 break-words">
              {t(errorKey(roles.error))}
            </span>
          </p>
          <Button size="sm" onClick={() => void roles.refetch()}>
            {t('app.retry')}
          </Button>
        </div>
      ) : null}
      {roles.isSuccess &&
        ROLES.map((role) => {
          const item = roles.data.items.find((i) => i.role === role);
          if (!item) return null;
          return (
            <ConnectorRoleRow
              key={role}
              role={role}
              item={item}
              connectors={props.connectors}
              onSaved={() => {
                void roles.refetch();
              }}
            />
          );
        })}
    </section>
  );
}
