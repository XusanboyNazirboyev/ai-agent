'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { assignableRoles, canEditMember, canManageTeam } from '@/lib/roles';
import type {
  CreatedInvite,
  PendingInvite,
  Role,
  TeamMember,
  TeamView,
} from '@/lib/types';
import { useShell } from './app-shell';
import { InviteLinkBox } from './invite-link-box';
import { SettingsSubPage } from './settings-section-nav';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { ErrorNote, QueryState } from './ui/error-note';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { Icon } from './ui/icons';
import { Select } from './ui/select';

type Pending =
  | { kind: 'role'; member: TeamMember; role: Role }
  | { kind: 'active'; member: TeamMember; isActive: boolean }
  | { kind: 'revoke'; invite: PendingInvite };

/**
 * Settings → Team (ADR 047 §5), OWNER and ADMIN. The rules (last owner,
 * ADMIN cannot grant OWNER, seat limit) are the API's; this page hides what
 * is never allowed and shows the API's answer for the rest.
 */
export function TeamPage(): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { operator } = useShell();
  const queryClient = useQueryClient();
  const manager = canManageTeam(operator.role);
  const roles = assignableRoles(operator.role);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('OPERATOR');
  const [pending, setPending] = useState<Pending | null>(null);

  const query = useQuery({
    queryKey: ['team'],
    queryFn: () => api<TeamView>('/api/v1/team'),
    enabled: manager,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['team'] });
  };
  const invite = useMutation({
    mutationFn: () =>
      api<CreatedInvite>('/api/v1/team/invites', {
        method: 'POST',
        body: { email: email.trim(), role },
      }),
    onSuccess: refresh,
  });
  const change = useMutation({
    mutationFn: (input: Pending) =>
      input.kind === 'revoke'
        ? api(`/api/v1/team/invites/${input.invite.id}`, { method: 'DELETE' })
        : api<TeamMember>(`/api/v1/team/operators/${input.member.id}`, {
            method: 'PATCH',
            body:
              input.kind === 'role'
                ? { role: input.role }
                : { isActive: input.isActive },
          }),
    onSuccess: refresh,
    onSettled: () => setPending(null),
  });
  useEffect(() => {
    if (inviting) return;
    setEmail('');
    setRole('OPERATOR');
    invite.reset();
  }, [inviting]);

  if (!manager)
    return (
      <SettingsSubPage active="team">
        <div className="mx-auto w-full max-w-4xl p-3 sm:p-6">
          <p role="status" className="text-sm text-muted">
            {t('team.managersOnly')}
          </p>
        </div>
      </SettingsSubPage>
    );

  const view = query.data;
  const created = invite.data;
  const limit = view?.limits.maxOperators ?? null;

  function confirmText(): { title: string; body: string; label: string } {
    if (!pending) return { title: '', body: '', label: '' };
    if (pending.kind === 'revoke')
      return {
        title: t('team.revokeTitle'),
        body: t('team.revokeBody', { email: pending.invite.email }),
        label: t('team.revoke'),
      };
    if (pending.kind === 'role')
      return {
        title: t('team.roleTitle'),
        body: t('team.roleBody', {
          name: pending.member.displayName,
          role: t(`role.${pending.role}`),
        }),
        label: t('team.changeRole'),
      };
    return pending.isActive
      ? {
          title: t('team.reactivateTitle'),
          body: t('team.reactivateBody', { name: pending.member.displayName }),
          label: t('team.reactivate'),
        }
      : {
          title: t('team.deactivateTitle'),
          body: t('team.deactivateBody', { name: pending.member.displayName }),
          label: t('team.deactivate'),
        };
  }
  const text = confirmText();

  return (
    <SettingsSubPage active="team">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('settings.section.team')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">{t('team.intro')}</p>
            <Button
              variant="primary"
              icon="plus"
              data-testid="team-invite"
              onClick={() => setInviting(true)}
            >
              {t('team.invite')}
            </Button>
          </div>
          {view ? (
            <p className="text-sm" data-testid="team-seats">
              {limit === null
                ? t('team.seatsUnlimited', { used: view.limits.seatsUsed })
                : t('team.seats', { used: view.limits.seatsUsed, limit })}
            </p>
          ) : null}
          <QueryState
            pending={query.isPending}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
          <ErrorNote error={change.error} testId="team-error" />

          <ul className="flex flex-col gap-2" aria-label={t('team.members')}>
            {(view?.operators ?? []).map((member) => {
              const editable = canEditMember(operator, member);
              return (
                <li
                  key={member.id}
                  data-testid="team-member"
                  data-email={member.email ?? ''}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card"
                >
                  <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                    <Avatar name={member.displayName} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {member.displayName}
                        {member.id === operator.id ? (
                          <span className="text-muted"> {t('team.you')}</span>
                        ) : null}
                      </span>
                      <span className="truncate text-sm text-muted">
                        {member.email ?? '—'}
                      </span>
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {member.isActive ? null : (
                      <Badge tone="warning">{t('team.inactive')}</Badge>
                    )}
                    {editable && member.isActive ? (
                      <Select
                        aria-label={t('team.roleOf', {
                          name: member.displayName,
                        })}
                        data-testid="member-role"
                        value={member.role}
                        disabled={change.isPending}
                        onChange={(e) =>
                          setPending({
                            kind: 'role',
                            member,
                            role: e.target.value as Role,
                          })
                        }
                        className="w-40"
                      >
                        {roles.map((item) => (
                          <option key={item} value={item}>
                            {t(`role.${item}`)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span data-testid="member-role-badge">
                        <Badge>{t(`role.${member.role}`)}</Badge>
                      </span>
                    )}
                    {editable ? (
                      <Button
                        size="sm"
                        variant={member.isActive ? 'ghost' : 'secondary'}
                        data-testid={
                          member.isActive
                            ? 'member-deactivate'
                            : 'member-reactivate'
                        }
                        onClick={() =>
                          setPending({
                            kind: 'active',
                            member,
                            isActive: !member.isActive,
                          })
                        }
                      >
                        {member.isActive
                          ? t('team.deactivate')
                          : t('team.reactivate')}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>

          <section
            aria-labelledby="team-pending"
            className="flex flex-col gap-2"
          >
            <h2 id="team-pending" className="font-semibold">
              {t('team.pending')}
            </h2>
            {view && view.invites.length === 0 ? (
              <p className="text-sm text-muted">{t('team.noInvites')}</p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {(view?.invites ?? []).map((item) => (
                <li
                  key={item.id}
                  data-testid="team-invite-row"
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-line bg-surface p-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon
                      name="clock"
                      className="h-4 w-4 shrink-0 text-muted"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{item.email}</span>
                      <span className="text-xs text-muted">
                        {t('team.inviteExpires', {
                          role: t(`role.${item.role}`),
                          date: formatDateTime(item.expiresAt),
                        })}
                      </span>
                    </span>
                  </span>
                  {roles.includes(item.role) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="x"
                      data-testid="team-invite-revoke"
                      onClick={() =>
                        setPending({ kind: 'revoke', invite: item })
                      }
                    >
                      {t('team.revoke')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <FormDialog
        open={inviting}
        title={t('team.inviteTitle')}
        description={created ? undefined : t('team.inviteBody')}
        testId="team-invite-dialog"
        onClose={() => setInviting(false)}
        onSubmit={() => {
          if (created) return setInviting(false);
          if (email.trim() && !invite.isPending) invite.mutate();
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
                {roles.map((item) => (
                  <option key={item} value={item}>
                    {t(`role.${item}`)}
                  </option>
                ))}
              </Select>
            </label>
            <ErrorNote error={invite.error} testId="invite-error" />
          </>
        )}
      </FormDialog>
      <ConfirmDialog
        open={pending !== null}
        title={text.title}
        body={text.body}
        confirmLabel={text.label}
        cancelLabel={t('confirm.cancel')}
        tone={
          pending?.kind === 'role' ||
          (pending?.kind === 'active' && pending.isActive)
            ? 'primary'
            : 'danger'
        }
        busy={change.isPending}
        onConfirm={() => {
          if (pending && !change.isPending) change.mutate(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </SettingsSubPage>
  );
}
