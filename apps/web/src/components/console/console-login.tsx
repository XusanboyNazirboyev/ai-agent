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
import {
  MfaCodeForm,
  MfaEnrollForm,
  RecoveryCodes,
  type MfaSetup,
} from '../mfa';

/** Platform console sign-in (ADR 047 §1): sets only the `ac_platform*` cookies. */
export function ConsoleLogin(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'password' | 'code' | 'enroll' | 'recovery'>(
    'password',
  );
  const [challenge, setChallenge] = useState('');
  const [setup, setSetup] = useState<MfaSetup | undefined>();
  const [codes, setCodes] = useState<string[]>([]);

  function finish(): void {
    queryClient.removeQueries({ queryKey: ['platform'] });
    router.replace('/console');
  }

  async function step2<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      return await work();
    } catch (failure) {
      setError(errorKey(failure));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await platformApi<{
        mfaRequired?: boolean;
        mfaEnrollmentRequired?: boolean;
        challenge?: string;
      }>('/api/v1/platform/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (result?.challenge && result.mfaRequired) {
        setChallenge(result.challenge);
        setStep('code');
        setBusy(false);
        return;
      }
      if (result?.challenge && result.mfaEnrollmentRequired) {
        setChallenge(result.challenge);
        setSetup(
          await platformApi<MfaSetup>('/api/v1/platform/auth/login/mfa/setup', {
            method: 'POST',
            body: { challenge: result.challenge },
          }),
        );
        setStep('enroll');
        setBusy(false);
        return;
      }
      finish();
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
      {step === 'code' ? (
        <MfaCodeForm
          busy={busy}
          error={error}
          onSubmit={(factor) =>
            void step2(async () => {
              await platformApi('/api/v1/platform/auth/login/mfa', {
                method: 'POST',
                body: { challenge, ...factor },
              });
              finish();
            })
          }
        />
      ) : step === 'enroll' && setup ? (
        <>
          <p role="status" className="text-sm text-muted">
            {t('mfa.console.required')}
          </p>
          <MfaEnrollForm
            setup={setup}
            busy={busy}
            error={error}
            onSubmit={(code) =>
              void step2(async () => {
                const done = await platformApi<{ recoveryCodes: string[] }>(
                  '/api/v1/platform/auth/login/mfa/enable',
                  { method: 'POST', body: { challenge, code } },
                );
                setCodes(done.recoveryCodes);
                setStep('recovery');
              })
            }
          />
        </>
      ) : step === 'recovery' ? (
        <RecoveryCodes codes={codes} onDone={finish} />
      ) : (
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
      )}
    </AuthCard>
  );
}
