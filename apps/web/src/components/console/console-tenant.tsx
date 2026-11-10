'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import { formatDate, formatUsd } from '@/lib/money';
import type { TenantDetail, TenantStatus } from '@/lib/platform-types';
import { TEAM_ROLES } from '@/lib/roles';
import type { CreatedInvite, PendingInvite, Role } from '@/lib/types';
import { InviteLinkBox } from '../invite-link-box';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ErrorNote, QueryState } from '../ui/error-note';
import { fieldClass } from '../ui/fields';
import { FormDialog } from '../ui/form-dialog';
import { Icon } from '../ui/icons';
import { ReasonDialog } from '../ui/reason-dialog';
import { Select } from '../ui/select';
import { Card, Field, TenantStatusBadge } from './console-format';
import { useConsole } from './console-shell';
import { useLocaleName } from './new-customer-dialog';
import { PaymentsCard, SubscriptionCard } from './tenant-billing';

type StatusAction = 'suspend' | 'reactivate' | 'archive';

const TARGET: Record<StatusAction, TenantStatus> = {
  suspend: 'SUSPENDED',
  reactivate: 'ACTIVE',
  archive: 'ARCHIVED',
};

/** One customer: summary, usage, status, subscription, payments, invites. */
export function ConsoleTenant(): ReactNode {
  const { t, locale } = useI18n();
  const { canWrite } = useConsole();
  const localeName = useLocaleName();
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const queryClient = useQueryClient();
  const [action, setAction] = useState<StatusAction | null>(null);

  const query = useQuery({
    queryKey: ['platform', 'tenant', id],
    queryFn: () => platformApi<TenantDetail>(`/api/v1/platform/tenants/${id}`),
    enabled: id.length > 0,
  });
  const status = useMutation({
    mutationFn: (input: { status: TenantStatus; reason: string }) =>
      platformApi(`/api/v1/platform/tenants/${id}`, {
        method: 'PATCH',
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['platform', 'tenant', id],
      });
      void queryClient.invalidateQueries({ queryKey: ['platform', 'tenants'] });
      setAction(null);
    },
  });
  useEffect(() => {
    if (action === null) status.reset();
  }, [action]);

  const back = (
    <Link
      href="/console"
      className="flex w-fit items-center gap-1 rounded-lg text-sm font-medium text-primary-fg hover:underline"
    >
      <Icon name="chevronLeft" className="h-4 w-4" />
      {t('console.tenant.back')}
    </Link>
  );
  if (!query.isSuccess)
    return (
      <div className="flex flex-col gap-4">
        {back}
        <QueryState
          pending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    );

  const detail = query.data;
  const tenant = detail.tenant;
  const actions: StatusAction[] =
    tenant.status === 'ACTIVE'
      ? ['suspend', 'archive']
      : tenant.status === 'SUSPENDED'
        ? ['reactivate', 'archive']
        : ['reactivate'];

  return (
    <div className="flex flex-col gap-4" data-testid="tenant-detail">
      {back}
      <Card
        title={tenant.name}
        testId="tenant-summary"
        actions={
          canWrite
            ? actions.map((item) => (
                <Button
                  key={item}
                  size="sm"
                  variant={item === 'reactivate' ? 'primary' : 'danger'}
                  data-testid={`tenant-${item}`}
                  onClick={() => setAction(item)}
                >
                  {t(`console.tenant.${item}`)}
                </Button>
              ))
            : undefined
        }
      >
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Field label={t('console.field.status')} testId="tenant-status">
            <TenantStatusBadge status={tenant.status} />
          </Field>
          <Field label={t('console.field.access')}>
            {t(`accessState.${detail.access.state}`)}
          </Field>
          <Field label={t('console.field.slug')}>
            <span className="font-mono">{tenant.slug}</span>
          </Field>
          <Field label={t('console.field.pack')}>
            {`${tenant.packKey}@${tenant.packVersion}`}
          </Field>
          <Field label={t('console.field.locale')}>
            {localeName(tenant.defaultLocale)}
          </Field>
          <Field label={t('console.field.timezone')}>{tenant.timezone}</Field>
          <Field label={t('console.field.created')}>
            {formatDate(tenant.createdAt, locale)}
          </Field>
          <Field label={t('console.field.channels')}>
            {detail.channels.length > 0
              ? detail.channels.map((channel) => channel.channelType).join(', ')
              : '—'}
          </Field>
        </dl>
      </Card>

      <Card title={t('console.usage.title')} testId="tenant-usage">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('console.usage.conversations')}>
            {detail.usage.conversations}
          </Field>
          <Field label={t('console.usage.inbound')}>
            {detail.usage.inboundMessages}
          </Field>
          <Field label={t('console.usage.llmCost')}>
            {formatUsd(detail.usage.llmCostUsd, locale)}
          </Field>
        </dl>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <SubscriptionCard tenantId={id} />
        <PaymentsCard
          tenantId={id}
          hasOpenSubscription={
            detail.subscription !== null &&
            ['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(detail.subscription.status)
          }
        />
      </div>

      <TeamCard tenantId={id} detail={detail} />

      {canWrite ? (
        <ReasonDialog
          open={action !== null}
          title={action ? t(`console.tenant.${action}Title`) : ''}
          body={action ? t(`console.tenant.${action}Body`) : ''}
          confirmLabel={action ? t(`console.tenant.${action}`) : ''}
          tone={action === 'reactivate' ? 'primary' : 'danger'}
          busy={status.isPending}
          error={status.error}
          onConfirm={(reason) => {
            if (action) status.mutate({ status: TARGET[action], reason });
          }}
          onCancel={() => setAction(null)}
        />
      ) : null}
    </div>
  );
}

function TeamCard(props: {
  tenantId: string;
  detail: TenantDetail;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { canWrite } = useConsole();
  const queryClient = useQueryClient();
  const base = `/api/v1/platform/tenants/${props.tenantId}/invites`;
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('OWNER');
  const [revoking, setRevoking] = useState<PendingInvite | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: ['platform', 'tenant', props.tenantId],
    });
  };
  const invite = useMutation({
    mutationFn: () =>
      platformApi<CreatedInvite>(base, {
        method: 'POST',
        body: { email: email.trim(), role },
      }),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) =>
      platformApi(`${base}/${inviteId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onSettled: () => setRevoking(null),
  });
  useEffect(() => {
    if (inviting) return;
    setEmail('');
    setRole('OWNER');
    invite.reset();
  }, [inviting]);

  const created = invite.data;
  return (
    <Card
      title={t('console.team.title')}
      testId="tenant-team"
      actions={
        canWrite ? (
          <Button
            size="sm"
            icon="plus"
            data-testid="tenant-invite"
            onClick={() => setInviting(true)}
          >
            {t('team.invite')}
          </Button>
        ) : undefined
      }
    >
      <ul className="flex flex-col gap-2">
        {props.detail.operators.map((operator) => (
          <li
            key={operator.id}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-sm first:border-t-0 first:pt-0"
          >
            <span className="min-w-0 truncate font-medium">
              {operator.displayName}
            </span>
            <span className="flex items-center gap-1.5">
              <Badge>{t(`role.${operator.role}`)}</Badge>
              {operator.isActive ? null : (
                <Badge tone="warning">{t('team.inactive')}</Badge>
              )}
            </span>
          </li>
        ))}
      </ul>
      {props.detail.operators.length === 0 ? (
        <p className="text-sm text-muted">{t('console.team.none')}</p>
      ) : null}
      <h3 className="text-sm font-semibold">{t('team.pending')}</h3>
      {props.detail.invites.length === 0 ? (
        <p className="text-sm text-muted">{t('team.noInvites')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {props.detail.invites.map((item) => (
            <li
              key={item.id}
              data-testid="tenant-invite-row"
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{item.email}</span>
                <span className="text-xs text-muted">
                  {t('team.inviteExpires', {
                    role: t(`role.${item.role}`),
                    date: formatDateTime(item.expiresAt),
                  })}
                </span>
              </span>
              {canWrite ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  data-testid="tenant-invite-revoke"
                  onClick={() => setRevoking(item)}
                >
                  {t('team.revoke')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={revoke.error} />
      {canWrite ? (
        <>
          <FormDialog
            open={inviting}
            title={t('team.inviteTitle')}
            description={created ? undefined : t('console.team.inviteBody')}
            testId="tenant-invite-dialog"
            onClose={() => setInviting(false)}
            onSubmit={() => {
              if (created) return setInviting(false);
              if (email.trim() && !invite.isPending) invite.mutate();
            }}
            footer={
              created ? (
                <Button
                  type="submit"
                  variant="primary"
                  data-testid="dialog-done"
                >
                  {t('action.done')}
                </Button>
              ) : (
                <>
                  <Button onClick={() => setInviting(false)}>
                    {t('confirm.cancel')}
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={invite.isPending}
                    disabled={!email.trim()}
                    data-testid="invite-submit"
                  >
                    {t('team.inviteSubmit')}
                  </Button>
                </>
              )
            }
          >
            {created ? (
              <InviteLinkBox
                path={created.path}
                expiresAt={created.expiresAt}
                email={created.email}
              />
            ) : (
              <>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  {t('login.email')}
                  <input
                    type="email"
                    inputMode="email"
                    data-testid="invite-email"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={fieldClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  {t('team.role')}
                  <Select
                    data-testid="invite-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as Role)}
                  >
                    {TEAM_ROLES.map((item) => (
                      <option key={item} value={item}>
                        {t(`role.${item}`)}
                      </option>
                    ))}
                  </Select>
                </label>
                <ErrorNote error={invite.error} />
              </>
            )}
          </FormDialog>
          <ConfirmDialog
            open={revoking !== null}
            title={t('team.revokeTitle')}
            body={t('team.revokeBody', { email: revoking?.email ?? '' })}
            confirmLabel={t('team.revoke')}
            cancelLabel={t('confirm.cancel')}
            tone="danger"
            busy={revoke.isPending}
            onConfirm={() => {
              if (revoking && !revoke.isPending) revoke.mutate(revoking.id);
            }}
            onCancel={() => setRevoking(null)}
          />
        </>
      ) : null}
    </Card>
  );
}
