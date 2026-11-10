'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { errorKey, platformApi } from '@/lib/api';
import { AuthCard } from '../auth-card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { fieldClass } from '../ui/fields';
import { Icon } from '../ui/icons';

/** Platform console sign-in (ADR 047 §1): sets only the `ac_platform*` cookies. */
export function ConsoleLogin(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await platformApi('/api/v1/platform/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      queryClient.removeQueries({ queryKey: ['platform'] });
      router.replace('/console');
    } catch (failure) {
      setError(errorKey(failure));
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={t('console.login.title')}
      subtitle={t('console.login.subtitle')}
      badge={<Badge tone="accent">{t('console.badge')}</Badge>}
    >
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
      >
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('login.email')}
          <input
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('login.password')}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            className={fieldClass}
          />
        </label>
        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(error)}
          </p>
        ) : null}
        <Button type="submit" variant="primary" loading={busy}>
          {busy ? t('login.submitting') : t('login.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
