'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { errorKey } from '@/lib/api';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';

/** The API call used by these components: tenant `api` or `platformApi`. */
export type MfaCall = <T>(
  path: string,
  options?: { method?: 'GET' | 'POST'; body?: unknown },
) => Promise<T>;

export interface MfaStatus {
  available: boolean;
  enabled: boolean;
  pending: boolean;
  recoveryCodesRemaining: number;
  required: boolean;
}

export interface MfaSetup {
  secret: string;
  otpauthUri: string;
}

function ErrorLine(props: { error: string | undefined }): ReactNode {
  const { t } = useI18n();
  return props.error ? (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
    >
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      {t(props.error)}
    </p>
  ) : null;
}

/** A read-only value with a copy button (the secret and URI are text, no QR). */
export function CopyField(props: {
  label: string;
  value: string;
  testId: string;
}): ReactNode {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <label htmlFor={props.testId}>{props.label}</label>
      <div className="flex gap-2">
        <input
          id={props.testId}
          data-testid={props.testId}
          readOnly
          value={props.value}
          onFocus={(event) => event.currentTarget.select()}
          className={`${fieldClass} font-mono text-sm`}
        />
        <Button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(props.value)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          {copied ? t('mfa.copied') : t('mfa.copy')}
        </Button>
      </div>
    </div>
  );
}

/** Second step of a sign-in: a 6-digit code, or a recovery code. */
export function MfaCodeForm(props: {
  onSubmit: (factor: { code: string } | { recoveryCode: string }) => void;
  busy: boolean;
  error: string | undefined;
}): ReactNode {
  const { t } = useI18n();
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  function submit(event: FormEvent): void {
    event.preventDefault();
    props.onSubmit(recovery ? { recoveryCode: value } : { code: value });
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      data-testid="mfa-form"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
    >
      <p className="text-sm text-muted">
        {recovery ? t('mfa.login.recoveryHint') : t('mfa.login.codeHint')}
      </p>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {recovery ? t('mfa.recoveryCode') : t('mfa.code')}
        <input
          name={recovery ? 'recoveryCode' : 'code'}
          data-testid="mfa-code"
          autoComplete="one-time-code"
          inputMode={recovery ? 'text' : 'numeric'}
          required
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={props.error ? true : undefined}
          className={fieldClass}
        />
      </label>
      <ErrorLine error={props.error} />
      <Button type="submit" variant="primary" loading={props.busy}>
        {t('mfa.login.submit')}
      </Button>
      <button
        type="button"
        data-testid="mfa-toggle-recovery"
        onClick={() => {
          setRecovery(!recovery);
          setValue('');
        }}
        className="min-h-9 text-sm text-primary-fg underline"
      >
        {recovery ? t('mfa.login.useCode') : t('mfa.login.useRecovery')}
      </button>
    </form>
  );
}

/** Setup key, otpauth URI and the confirming code (used by login enrolment and Security). */
export function MfaEnrollForm(props: {
  setup: MfaSetup;
  onSubmit: (code: string) => void;
  busy: boolean;
  error: string | undefined;
}): ReactNode {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  return (
    <form
      noValidate
      data-testid="mfa-enroll"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(code);
      }}
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
    >
      <p className="text-sm text-muted">{t('mfa.setup.intro')}</p>
      <CopyField
        label={t('mfa.setup.secret')}
        value={props.setup.secret}
        testId="mfa-secret"
      />
      <CopyField
        label={t('mfa.setup.uri')}
        value={props.setup.otpauthUri}
        testId="mfa-uri"
      />
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t('mfa.setup.confirm')}
        <input
          name="code"
          data-testid="mfa-enroll-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className={fieldClass}
        />
      </label>
      <ErrorLine error={props.error} />
      <Button type="submit" variant="primary" loading={props.busy}>
        {t('mfa.setup.enable')}
      </Button>
    </form>
  );
}

/** Recovery codes, shown once. */
export function RecoveryCodes(props: {
  codes: string[];
  onDone: () => void;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div
      data-testid="mfa-recovery"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
    >
      <h2 className="font-semibold">{t('mfa.recovery.title')}</h2>
      <p className="text-sm text-muted">{t('mfa.recovery.hint')}</p>
      <ul
        data-testid="mfa-recovery-codes"
        className="grid grid-cols-2 gap-2 font-mono text-sm"
      >
        {props.codes.map((code) => (
          <li key={code} className="rounded-lg bg-surface-2 px-3 py-2">
            {code}
          </li>
        ))}
      </ul>
      <CopyField
        label={t('mfa.recovery.copyAll')}
        value={props.codes.join('\n')}
        testId="mfa-recovery-all"
      />
      <Button
        type="button"
        variant="primary"
        data-testid="mfa-recovery-done"
        onClick={props.onDone}
      >
        {t('mfa.recovery.done')}
      </Button>
    </div>
  );
}

/** Security section body, for tenant Settings and the console. */
export function MfaSecurityPanel(props: {
  call: MfaCall;
  prefix: string;
  queryKey: string[];
}): ReactNode {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: props.queryKey,
    queryFn: () => props.call<MfaStatus>(props.prefix),
  });
  const [setup, setSetup] = useState<MfaSetup | undefined>();
  const [codes, setCodes] = useState<string[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: props.queryKey });
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setBusy(false);
    }
  }

  const data = status.data;
  if (!data)
    return (
      <p role="status" className="text-sm text-muted">
        {status.isError ? t('errors.UNKNOWN') : t('app.loading')}
      </p>
    );
  if (codes)
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes(undefined);
          setCode('');
        }}
      />
    );

  return (
    <div className="flex flex-col gap-4" data-testid="mfa-security">
      <p className="text-sm text-muted">{t('mfa.security.intro')}</p>
      <p
        data-testid="mfa-state"
        className="flex items-center gap-2 text-sm font-medium"
      >
        <Icon name={data.enabled ? 'check' : 'alert'} className="h-4 w-4" />
        {data.enabled ? t('mfa.state.on') : t('mfa.state.off')}
      </p>
      {!data.available ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t('errors.MFA_NOT_AVAILABLE')}
        </p>
      ) : null}

      {!data.enabled && data.available && !setup ? (
        <div>
          <Button
            type="button"
            variant="primary"
            data-testid="mfa-start"
            loading={busy}
            onClick={() =>
              void run(async () => {
                setSetup(
                  await props.call<MfaSetup>(`${props.prefix}/setup`, {
                    method: 'POST',
                  }),
                );
              })
            }
          >
            {t('mfa.setup.start')}
          </Button>
        </div>
      ) : null}
      {!data.enabled && setup ? (
        <MfaEnrollForm
          setup={setup}
          busy={busy}
          error={error}
          onSubmit={(value) =>
            void run(async () => {
              const result = await props.call<{ recoveryCodes: string[] }>(
                `${props.prefix}/enable`,
                { method: 'POST', body: { code: value } },
              );
              setSetup(undefined);
              setCodes(result.recoveryCodes);
            })
          }
        />
      ) : null}

      {data.enabled ? (
        <form
          noValidate
          data-testid="mfa-manage"
          onSubmit={(event) => event.preventDefault()}
          className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card"
        >
          <p className="text-sm text-muted">
            {t('mfa.recovery.remaining', {
              count: data.recoveryCodesRemaining,
            })}
          </p>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('mfa.code')}
            <input
              name="code"
              data-testid="mfa-manage-code"
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={fieldClass}
            />
          </label>
          {!data.required ? (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              {t('login.password')}
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                data-testid="mfa-manage-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={fieldClass}
              />
            </label>
          ) : null}
          <ErrorLine error={error} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              data-testid="mfa-regenerate"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  const result = await props.call<{ recoveryCodes: string[] }>(
                    `${props.prefix}/recovery-codes`,
                    { method: 'POST', body: { code } },
                  );
                  setCodes(result.recoveryCodes);
                })
              }
            >
              {t('mfa.recovery.regenerate')}
            </Button>
            {!data.required ? (
              <Button
                type="button"
                variant="danger"
                data-testid="mfa-disable"
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await props.call(`${props.prefix}/disable`, {
                      method: 'POST',
                      body: { password, code },
                    });
                    setCode('');
                    setPassword('');
                  })
                }
              >
                {t('mfa.disable')}
              </Button>
            ) : (
              <p className="text-sm text-muted">{t('mfa.requiredHere')}</p>
            )}
          </div>
        </form>
      ) : null}
    </div>
  );
}
