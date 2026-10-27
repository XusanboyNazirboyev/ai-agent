'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { LocaleSwitcher } from './locale-switcher';
import { BrandLogo } from './ui/brand';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';

export function LoginForm(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/v1/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      router.replace('/inbox');
    } catch (failure) {
      setError(errorKey(failure));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-canvas lg:grid lg:grid-cols-[1.05fr_1fr]">
      <aside
        aria-hidden="true"
        className="hidden flex-col justify-between bg-linear-to-br from-[#0b2f8f] via-primary to-[#2d68f2] p-12 text-white lg:flex"
      >
        <BrandLogo name={t('app.brand')} inverse className="text-3xl" />
        <div className="flex max-w-md flex-col gap-8">
          <p className="text-4xl leading-tight font-semibold">
            {t('login.tagline')}
          </p>
          <ul className="flex flex-col gap-4">
            {['login.point1', 'login.point2', 'login.point3'].map((key) => (
              <li key={key} className="flex items-start gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/20">
                  <Icon name="check" className="h-4 w-4" />
                </span>
                <span className="text-base text-on-primary-muted">
                  {t(key)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-on-primary-muted">
          {t('login.taglineHint')}
        </p>
      </aside>

      <div className="flex flex-1 flex-col px-4 py-6 sm:px-8">
        <div className="flex justify-end">
          <LocaleSwitcher />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6">
          <div className="flex flex-col gap-2">
            <BrandLogo name={t('app.brand')} className="lg:hidden" />
            <h1 className="text-2xl font-semibold tracking-tight">
              {t('login.title')}
            </h1>
            <p className="text-sm text-muted">{t('login.subtitle')}</p>
          </div>
          <form
            onSubmit={submit}
            className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
            noValidate
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
        </div>
      </div>
    </main>
  );
}
