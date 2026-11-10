'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import type { Plan, TenantOptions } from '@/lib/platform-types';
import type { CreatedInvite } from '@/lib/types';
import { InviteLinkBox } from '../invite-link-box';
import { Button, buttonClass } from '../ui/button';
import { ErrorNote } from '../ui/error-note';
import { fieldClass } from '../ui/fields';
import { FormDialog } from '../ui/form-dialog';
import { Select } from '../ui/select';

const DEFAULT_TIMEZONE = 'Asia/Tashkent';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;

/** A slug suggestion from a business name (Latin letters and digits). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
}

/** Locale ids the catalog names; any other id is shown as it is. */
export function useLocaleName(): (id: string) => string {
  const { t } = useI18n();
  return (id) => {
    const key = `locale.${id}`;
    const label = t(key);
    return label === key ? id : label;
  };
}

interface Created {
  tenant: { id: string; slug: string; name: string };
  invite: CreatedInvite;
}

/**
 * "New customer": a tenant plus the invite of its first OWNER (ADR 047 §4).
 * No password passes through the console; the invite link is shown once.
 */
export function NewCustomerDialog(props: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const { t, locale } = useI18n();
  const localeName = useLocaleName();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [email, setEmail] = useState('');
  const [pack, setPack] = useState('');
  const [language, setLanguage] = useState('');
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [planId, setPlanId] = useState('');
  const [trialDays, setTrialDays] = useState('');
  const [invalid, setInvalid] = useState(false);

  const options = useQuery({
    queryKey: ['platform', 'tenant-options'],
    queryFn: () =>
      platformApi<TenantOptions>('/api/v1/platform/tenants/options'),
    enabled: props.open,
  });
  const plans = useQuery({
    queryKey: ['platform', 'plans'],
    queryFn: () => platformApi<{ plans: Plan[] }>('/api/v1/platform/plans'),
    enabled: props.open,
  });
  const create = useMutation({
    mutationFn: () =>
      platformApi<Created>('/api/v1/platform/tenants', {
        method: 'POST',
        body: {
          name: name.trim(),
          slug,
          ownerEmail: email.trim(),
          pack,
          defaultLocale: language,
          timezone: timezone.trim(),
          ...(planId ? { planId } : {}),
          ...(planId && trialDays ? { trialDays: Number(trialDays) } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform', 'tenants'] });
    },
  });

  useEffect(() => {
    if (props.open) return;
    // Closed: nothing of the last customer (or its invite link) remains.
    setName('');
    setSlug('');
    setSlugTouched(false);
    setEmail('');
    setPlanId('');
    setTrialDays('');
    setTimezone(DEFAULT_TIMEZONE);
    setInvalid(false);
    create.reset();
  }, [props.open]);
  useEffect(() => {
    if (!pack && options.data?.packs[0]) setPack(options.data.packs[0]);
    if (!language && options.data?.locales.length)
      setLanguage(
        options.data.locales.includes('uz-Latn')
          ? 'uz-Latn'
          : options.data.locales[0],
      );
  }, [options.data, pack, language]);

  const trial = trialDays === '' ? undefined : Number(trialDays);
  const valid =
    name.trim().length > 0 &&
    SLUG.test(slug) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim()) &&
    pack !== '' &&
    language !== '' &&
    timezone.trim() !== '' &&
    (trial === undefined ||
      (Number.isInteger(trial) && trial >= 1 && trial <= 365));

  function submit(): void {
    if (!valid) {
      setInvalid(true);
      return;
    }
    if (!create.isPending) create.mutate();
  }

  const activePlans = (plans.data?.plans ?? []).filter((plan) => plan.isActive);
  const done = create.data;

  return (
    <FormDialog
      open={props.open}
      title={t('console.newCustomer.title')}
      description={done ? undefined : t('console.newCustomer.intro')}
      testId="new-customer-dialog"
      onClose={props.onClose}
      onSubmit={done ? props.onClose : submit}
      footer={
        done ? (
          <>
            <Link
              href={`/console/tenants/${done.tenant.id}`}
              className={buttonClass('secondary')}
              data-testid="open-customer"
            >
              {t('console.newCustomer.open')}
            </Link>
            <Button type="submit" variant="primary" data-testid="dialog-done">
              {t('action.done')}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={props.onClose} data-testid="dialog-cancel">
              {t('confirm.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={create.isPending}
              data-testid="new-customer-submit"
            >
              {t('console.newCustomer.submit')}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <InviteLinkBox
          path={done.invite.path}
          expiresAt={done.invite.expiresAt}
          email={done.invite.email}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
            {t('console.field.name')}
            <input
              data-testid="customer-name"
              required
              maxLength={200}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              aria-invalid={invalid && !name.trim() ? true : undefined}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('console.field.slug')}
            <input
              data-testid="customer-slug"
              required
              maxLength={80}
              autoCapitalize="off"
              spellCheck={false}
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
              aria-invalid={invalid && !SLUG.test(slug) ? true : undefined}
              className={fieldClass}
            />
            <span className="text-xs font-normal text-muted">
              {t('console.field.slugHint')}
            </span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('console.field.ownerEmail')}
            <input
              data-testid="customer-email"
              type="email"
              inputMode="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('console.field.pack')}
            <Select
              data-testid="customer-pack"
              value={pack}
              onChange={(e) => setPack(e.target.value)}
            >
              {(options.data?.packs ?? []).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('console.field.locale')}
            <Select
              data-testid="customer-locale"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {(options.data?.locales ?? []).map((id) => (
                <option key={id} value={id}>
                  {localeName(id)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('console.field.timezone')}
            <input
              data-testid="customer-timezone"
              required
              maxLength={64}
              autoCapitalize="off"
              spellCheck={false}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('console.field.plan')}
            <Select
              data-testid="customer-plan"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
            >
              <option value="">{t('console.field.noPlan')}</option>
              {activePlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {t('console.planOption', {
                    name: plan.name,
                    price: formatMoney(plan.priceMinor, plan.currency, locale),
                    days: plan.periodDays,
                  })}
                </option>
              ))}
            </Select>
          </label>
          {planId ? (
            <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
              {t('console.field.trialDays')}
              <input
                data-testid="customer-trial"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
                className={fieldClass}
              />
              <span className="text-xs font-normal text-muted">
                {t('console.field.trialHint')}
              </span>
            </label>
          ) : null}
          {invalid && !valid ? (
            <p
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg sm:col-span-2"
            >
              {t('console.formInvalid')}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <ErrorNote error={create.error ?? options.error} />
          </div>
        </div>
      )}
    </FormDialog>
  );
}
