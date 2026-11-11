'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, ApiError, errorKey, platformApi } from '@/lib/api';
import type { InvitePreview } from '@/lib/types';
import { AuthCard } from './auth-card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';

/** Password lengths the two accept endpoints require (API zod schemas). */
export const MIN_PASSWORD = { tenant: 10, platform: 12 } as const;

type Kind = keyof typeof MIN_PASSWORD;

/**
 * Accepting an invite (ADR 047 §5): the person chooses their own name and
 * password, the API creates the login and signs this browser in. The token
 * in the address is the credential; it is sent once and never stored.
 */
export function InviteAccept(props: { kind: Kind }): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const min = MIN_PASSWORD[props.kind];

  const preview = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () =>
      api<InvitePreview>(`/api/v1/auth/invites/${encodeURIComponent(token)}`),
    enabled: props.kind === 'tenant' && token.length > 0,
    retry: false,
  });
  const invalid =
    props.kind === 'tenant' &&
    preview.error instanceof ApiError &&
    preview.error.status === 404;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    if (props.kind === 'tenant' && !name.trim())
      return setError('invite.accept.nameRequired');
    if (password.length < min) return setError('invite.accept.tooShort');
    if (password !== repeat) return setError('invite.accept.mismatch');
    setBusy(true);
    const path = `${props.kind === 'platform' ? '/api/v1/platform/auth' : '/api/v1/auth'}/invites/${encodeURIComponent(token)}/accept`;
    const body = {
      ...(name.trim() ? { displayName: name.trim() } : {}),
      password,
    };
    try {
      if (props.kind === 'platform')
        await platformApi(path, { method: 'POST', body });
      else await api(path, { method: 'POST', body });
      setPassword('');
      setRepeat('');
      queryClient.clear();
      router.replace(props.kind === 'platform' ? '/console/login' : '/inbox');
    } catch (failure) {
      setError(errorKey(failure));
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={t('invite.accept.title')}
      subtitle={
        preview.data
          ? t('invite.accept.subtitleTenant', {
              tenant: preview.data.tenantName,
              role: t(`role.${preview.data.role}`),
            })
          : props.kind === 'platform'
            ? t('invite.accept.subtitlePlatform')
            : undefined
      }
      badge={
        props.kind === 'platform' ? (
          <Badge tone="accent">{t('console.badge')}</Badge>
        ) : undefined
      }
    >
      {invalid ? (
        <p
          role="alert"
          data-testid="invite-invalid"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          {t('team.errors.INVITE_INVALID')}
        </p>
      ) : (
        <form
          onSubmit={submit}
          noValidate
          data-testid="invite-accept"
          className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
        >
          {preview.data ? (
            <p className="text-sm text-muted">
              {t('invite.accept.email', { email: preview.data.email })}
            </p>
          ) : null}
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {props.kind === 'platform'
              ? t('invite.accept.nameOptional')
              : t('invite.accept.name')}
            <input
              name="displayName"
              autoComplete="name"
              required={props.kind === 'tenant'}
              maxLength={160}
              autoFocus
              data-testid="invite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('invite.accept.password')}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={min}
              maxLength={200}
              data-testid="invite-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              className={fieldClass}
            />
            <span className="text-xs font-normal text-muted">
              {t('invite.accept.passwordHint', { min })}
            </span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('invite.accept.repeat')}
            <input
              name="repeat"
              type="password"
              autoComplete="new-password"
              required
              maxLength={200}
              data-testid="invite-repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              aria-invalid={error ? true : undefined}
              className={fieldClass}
            />
          </label>
          {error ? (
            <p
              role="alert"
              data-testid="invite-error"
              className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
            >
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              {t(error, { min })}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            data-testid="invite-submit"
          >
            {t('invite.accept.submit')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
