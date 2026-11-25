'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { PublicPlans } from '@/lib/public-site';
import {
  BUSINESS_TYPES,
  DEFAULT_PLAN_CODE,
  SIGNUP_MIN_PASSWORD,
  SIGNUP_POLL_MS,
  planFromSearch,
  pollAction,
  signupExpired,
  signupFormProblem,
  type BusinessType,
  type SignupCreated,
  type SignupForm,
  type SignupStatus,
} from '@/lib/signup';
import { AuthCard } from './auth-card';
import { Button, buttonClass } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Select } from './ui/select';
import { PasswordInput } from './ui/password-input';

/**
 * Public signup (ADR 080), two steps: the form, then "Confirm in Telegram".
 * The page waits for the platform bot, and the API signs this browser in.
 */
export function SignupPage(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<unknown>('/api/v1/auth/me'),
    retry: false,
  });
  useEffect(() => {
    if (me.isSuccess) router.replace('/today');
  }, [me.isSuccess, router]);

  const [planParam, setPlanParam] = useState<string | undefined>();
  useEffect(() => {
    setPlanParam(planFromSearch(window.location.search));
  }, []);
  const plans = useQuery({
    queryKey: ['public-plans'],
    queryFn: () => api<PublicPlans>('/api/v1/public/plans'),
    retry: false,
    staleTime: 60_000,
    enabled: planParam === undefined,
  });
  const planCode = planParam ?? plans.data?.plans[0]?.code ?? DEFAULT_PLAN_CODE;
  const planName =
    plans.data?.plans.find((plan) => plan.code === planCode)?.name ?? planCode;

  const [form, setForm] = useState<SignupForm>({
    businessName: '',
    businessType: '',
    name: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<SignupCreated | undefined>();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const problem = signupFormProblem(form);
    if (problem) return setError(problem);
    setError(undefined);
    setBusy(true);
    try {
      setCreated(
        await api<SignupCreated>('/api/v1/public/signups', {
          method: 'POST',
          body: {
            businessName: form.businessName.trim(),
            packKey: form.businessType,
            name: form.name.trim(),
            email: form.email.trim(),
            password: form.password,
            planCode,
          },
        }),
      );
    } catch (failure) {
      setError(errorKey(failure));
    }
    setBusy(false);
  }

  function field(key: Exclude<keyof SignupForm, 'businessType'>): {
    value: string;
    onChange: (e: { target: { value: string } }) => void;
  } {
    return {
      value: form[key],
      onChange: (e) => setForm({ ...form, [key]: e.target.value }),
    };
  }

  if (created)
    return (
      <ConfirmStep
        created={created}
        onSignedIn={() => {
          queryClient.clear();
          router.replace('/today?welcome=1');
        }}
        onRestart={() => {
          setCreated(undefined);
          setForm({ ...form, password: '' });
        }}
      />
    );

  return (
    <AuthCard title={t('signup.title')} subtitle={t('signup.subtitle')}>
      <form
        onSubmit={submit}
        noValidate
        data-testid="signup-form"
        className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
      >
        <p className="text-sm text-muted" data-testid="signup-plan">
          {t('signup.plan', { plan: planName })}
        </p>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('signup.business')}
          <input
            name="businessName"
            autoComplete="organization"
            maxLength={120}
            autoFocus
            data-testid="signup-business"
            className={fieldClass}
            {...field('businessName')}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('signup.type')}
          <Select
            field
            name="businessType"
            value={form.businessType}
            onChange={(e) =>
              setForm({
                ...form,
                businessType: e.target.value as BusinessType,
              })
            }
            className="w-full"
            data-testid="signup-type"
          >
            <option value="" disabled>
              {t('signup.typeChoose')}
            </option>
            {BUSINESS_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`signup.typeOption.${type}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('signup.name')}
          <input
            name="name"
            autoComplete="name"
            maxLength={80}
            data-testid="signup-name"
            className={fieldClass}
            {...field('name')}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('signup.email')}
          <input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            maxLength={254}
            data-testid="signup-email"
            className={fieldClass}
            {...field('email')}
          />
          <span className="text-xs font-normal text-muted">
            {t('signup.emailHint')}
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('signup.password')}
          <PasswordInput
            name="password"
            autoComplete="new-password"
            maxLength={200}
            data-testid="signup-password"
            className={fieldClass}
            {...field('password')}
          />
          <span className="text-xs font-normal text-muted">
            {t('signup.passwordHint', { min: SIGNUP_MIN_PASSWORD })}
          </span>
        </label>
        {error ? (
          <p
            role="alert"
            data-testid="signup-error"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(error, { min: SIGNUP_MIN_PASSWORD })}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          data-testid="signup-submit"
        >
          {t('signup.submit')}
        </Button>
        <p className="text-xs text-muted">{t('signup.trialNote')}</p>
      </form>
      <p className="text-center text-sm">
        {t('signup.haveAccount')}{' '}
        <Link href="/login" className="font-medium underline">
          {t('signup.signIn')}
        </Link>
      </p>
    </AuthCard>
  );
}

/** Step 2: open the bot, share the phone, and wait here until it is confirmed. */
export function ConfirmStep(props: {
  created: SignupCreated;
  onSignedIn: () => void;
  onRestart: () => void;
}): ReactNode {
  const { t } = useI18n();
  const { created, onSignedIn } = props;
  const [state, setState] = useState<'wait' | 'expired' | 'refused' | 'signin'>(
    'wait',
  );

  useEffect(() => {
    if (state !== 'wait') return;
    let stopped = false;
    async function tick(): Promise<void> {
      if (signupExpired(created.expiresAt, Date.now())) {
        if (!stopped) setState('expired');
        return;
      }
      try {
        const status = await api<SignupStatus>(
          `/api/v1/public/signups/${encodeURIComponent(created.id)}`,
        );
        if (stopped) return;
        const action = pollAction(status);
        if (action === 'welcome') onSignedIn();
        else if (action !== 'wait') setState(action);
      } catch {
        /* a failed poll is tried again on the next tick */
      }
    }
    const timer = setInterval(() => void tick(), SIGNUP_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state, created, onSignedIn]);

  return (
    <AuthCard title={t('signup.confirm.title')}>
      <div
        data-testid="signup-confirm"
        className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
      >
        {state === 'wait' ? (
          <>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
              <li>{t('signup.confirm.step1')}</li>
              <li>{t('signup.confirm.step2')}</li>
              <li>{t('signup.confirm.step3')}</li>
            </ol>
            <a
              href={created.telegramUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="signup-telegram"
              className={`${buttonClass('primary', 'md')} w-full justify-center`}
            >
              {t('signup.confirm.open')}
            </a>
            <p
              role="status"
              data-testid="signup-waiting"
              className="text-sm text-muted"
            >
              {t('signup.confirm.waiting')}
            </p>
          </>
        ) : (
          <>
            <p
              role="alert"
              data-testid={`signup-${state}`}
              className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
            >
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              {t(`signup.confirm.${state}`)}
            </p>
            {state === 'expired' ? (
              <Button variant="primary" onClick={props.onRestart}>
                {t('signup.confirm.restart')}
              </Button>
            ) : (
              <Link
                href="/login"
                className={`${buttonClass('primary', 'md')} justify-center`}
              >
                {t('signup.signIn')}
              </Link>
            )}
          </>
        )}
      </div>
    </AuthCard>
  );
}
