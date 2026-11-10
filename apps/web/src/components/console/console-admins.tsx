'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import type { PlatformAdminRow } from '@/lib/platform-types';
import type { PlatformRole } from '@/lib/roles';
import type { CreatedInvite } from '@/lib/types';
import { InviteLinkBox } from '../invite-link-box';
import { Avatar } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ErrorNote, QueryState } from '../ui/error-note';
import { fieldClass } from '../ui/fields';
import { FormDialog } from '../ui/form-dialog';
import { Select } from '../ui/select';
import { useConsole } from './console-shell';

const ROLES: PlatformRole[] = ['PLATFORM_OWNER', 'PLATFORM_SUPPORT'];

/** Platform admins (PLATFORM_OWNER only): list, invite, deactivate. */
export function ConsoleAdmins(): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { admin, canWrite } = useConsole();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<PlatformRole>('PLATFORM_SUPPORT');
  const [target, setTarget] = useState<PlatformAdminRow | null>(null);

  const query = useQuery({
    queryKey: ['platform', 'admins'],
    queryFn: () =>
      platformApi<{ admins: PlatformAdminRow[] }>('/api/v1/platform/admins'),
    enabled: canWrite,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['platform', 'admins'] });
  };
  const invite = useMutation({
    mutationFn: () =>
      platformApi<CreatedInvite>('/api/v1/platform/admins', {
        method: 'POST',
        body: { email: email.trim(), displayName: name.trim(), role },
      }),
    onSuccess: refresh,
  });
  const deactivate = useMutation({
    mutationFn: (id: string) =>
      platformApi(`/api/v1/platform/admins/${id}/deactivate`, {
        method: 'POST',
      }),
    onSuccess: refresh,
    onSettled: () => setTarget(null),
  });
  useEffect(() => {
    if (inviting) return;
    setEmail('');
    setName('');
    setRole('PLATFORM_SUPPORT');
    invite.reset();
  }, [inviting]);

  if (!canWrite)
    return (
      <p
        role="alert"
        className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
      >
        {t('errors.FORBIDDEN')}
      </p>
    );

  const created = invite.data;
  const admins = query.data?.admins ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{t('console.admins.intro')}</p>
        <Button
          variant="primary"
          icon="plus"
          data-testid="admin-invite"
          onClick={() => setInviting(true)}
        >
          {t('console.admins.invite')}
        </Button>
      </div>
      <QueryState
        pending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      <ErrorNote error={deactivate.error} />
      <ul className="flex flex-col gap-2">
        {admins.map((row) => (
          <li
            key={row.id}
            data-testid="admin-row"
            className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card"
          >
            <span className="flex min-w-0 items-center gap-3">
              <Avatar name={row.displayName} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{row.displayName}</span>
                <span className="truncate text-sm text-muted">{row.email}</span>
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone="accent">{t(`platformRole.${row.role}`)}</Badge>
              {!row.isActive ? (
                <Badge tone="neutral">{t('team.inactive')}</Badge>
              ) : row.invitePending ? (
                <Badge tone="warning">
                  {row.inviteExpiresAt
                    ? t('console.admins.pendingUntil', {
                        date: formatDateTime(row.inviteExpiresAt),
                      })
                    : t('console.admins.pending')}
                </Badge>
              ) : null}
              {row.isActive && row.id !== admin.id ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="admin-deactivate"
                  onClick={() => setTarget(row)}
                >
                  {t('team.deactivate')}
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      <FormDialog
        open={inviting}
        title={t('console.admins.invite')}
        description={created ? undefined : t('console.admins.inviteBody')}
        testId="admin-invite-dialog"
        onClose={() => setInviting(false)}
        onSubmit={() => {
          if (created) return setInviting(false);
          if (email.trim() && name.trim() && !invite.isPending) invite.mutate();
        }}
        footer={
          created ? (
            <Button type="submit" variant="primary" data-testid="dialog-done">
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
                disabled={!email.trim() || !name.trim()}
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
              {t('invite.accept.name')}
              <input
                data-testid="admin-name"
                required
                maxLength={160}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={fieldClass}
              />
            </label>
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
                onChange={(e) => setRole(e.target.value as PlatformRole)}
              >
                {ROLES.map((item) => (
                  <option key={item} value={item}>
                    {t(`platformRole.${item}`)}
                  </option>
                ))}
              </Select>
            </label>
            <ErrorNote error={invite.error} />
          </>
        )}
      </FormDialog>
      <ConfirmDialog
        open={target !== null}
        title={t('console.admins.deactivateTitle')}
        body={t('console.admins.deactivateBody', {
          name: target?.displayName ?? '',
        })}
        confirmLabel={t('team.deactivate')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={deactivate.isPending}
        onConfirm={() => {
          if (target && !deactivate.isPending) deactivate.mutate(target.id);
        }}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}
