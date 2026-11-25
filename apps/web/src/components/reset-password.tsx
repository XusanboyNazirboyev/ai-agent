'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, ApiError, errorKey } from '@/lib/api';
import { AuthCard } from './auth-card';
import { MIN_PASSWORD } from './invite-accept';
import { Button, buttonClass } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { PasswordInput } from './ui/password-input';

interface ResetPreview {
  email: string;
  displayName: string;
  tenantName: string;
  expiresAt: string;
}

/**
 * A one-time password reset link (ADR 047 amendment 2026-11-17): the person
 * sets a new password and then signs in with it (and MFA, if enabled). The
 * token in the address is the credential; it is sent once and never stored.
 */
export function ResetPassword(): ReactNode {
  const { t } = useI18n();
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const min = MIN_PASSWORD.tenant;
  const path = `/api/v1/auth/password-resets/${encodeURIComponent(token)}`;

  const preview = useQuery({
    queryKey: ['password-reset', token],
    queryFn: () => api<ResetPreview>(path),
    enabled: token.length > 0 && !done,
    retry: false,
  });
  const invalid =
    preview.error instanceof ApiError && preview.error.status === 404;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    if (password.length < min) return setError('invite.accept.tooShort');
    if (password !== repeat) return setError('invite.accept.mismatch');
    setBusy(true);
    try {
      await api(path, { method: 'POST', body: { password } });
      setPassword('');
      setRepeat('');
      setDone(true);
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={t('reset.title')}
      subtitle={
        preview.data
          ? t('reset.subtitle', {
              name: preview.data.displayName,
              tenant: preview.data.tenantName,
            })
          : undefined
      }
    >
      {done ? (
        <div
          role="status"
          data-testid="reset-done"
          className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
        >
          <p className="text-sm">{t('reset.done')}</p>
          <Link href="/login" className={buttonClass('primary')}>
            {t('reset.toLogin')}
          </Link>
        </div>
      ) : invalid ? (
        <p
          role="alert"
          data-testid="reset-invalid"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          {t('team.errors.RESET_INVALID')}
        </p>
      ) : (
        <form
          onSubmit={submit}
          noValidate
          data-testid="reset-form"
          className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
        >
          {preview.data ? (
            <p className="text-sm text-muted">
              {t('invite.accept.email', { email: preview.data.email })}
            </p>
          ) : null}
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('invite.accept.password')}
            <PasswordInput
              name="password"
              autoComplete="new-password"
              required
              minLength={min}
              maxLength={200}
              autoFocus
              data-testid="reset-password"
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
            <PasswordInput
              name="repeat"
              autoComplete="new-password"
              required
              maxLength={200}
              data-testid="reset-repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              aria-invalid={error ? true : undefined}
              className={fieldClass}
            />
          </label>
          {error ? (
            <p
              role="alert"
              data-testid="reset-error"
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
            data-testid="reset-submit"
          >
            {t('reset.submit')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
