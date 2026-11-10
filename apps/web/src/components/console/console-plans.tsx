'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import { formatMoney, minorDigits, parseMoneyInput } from '@/lib/money';
import type { Plan, PlanLimits } from '@/lib/platform-types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { EmptyState, ErrorNote, QueryState } from '../ui/error-note';
import { fieldClass } from '../ui/fields';
import { FormDialog } from '../ui/form-dialog';
import { Field } from './console-format';
import { useConsole } from './console-shell';

const CODE = /^[a-z0-9][a-z0-9_-]{0,58}[a-z0-9]$/u;

/** Major-unit text of a minor amount for editing ("150000" or "99.50"). */
export function moneyInputText(amountMinor: number, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) return String(amountMinor);
  const text = String(amountMinor).padStart(digits + 1, '0');
  const whole = text.slice(0, -digits);
  const fraction = text.slice(-digits);
  return /^0+$/u.test(fraction) ? whole : `${whole}.${fraction}`;
}

function optionalInt(text: string): number | undefined | null {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= 10_000
    ? value
    : null;
}

/** Subscription plans (ADR 047 §2): prices are typed here, never seeded. */
export function ConsolePlans(): ReactNode {
  const { t, locale } = useI18n();
  const { canWrite } = useConsole();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<Plan | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('UZS');
  const [period, setPeriod] = useState('30');
  const [maxOperators, setMaxOperators] = useState('');
  const [maxChannels, setMaxChannels] = useState('');
  const [invalid, setInvalid] = useState(false);

  const query = useQuery({
    queryKey: ['platform', 'plans'],
    queryFn: () => platformApi<{ plans: Plan[] }>('/api/v1/platform/plans'),
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['platform', 'plans'] });
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing === 'new' || editing === null
        ? platformApi<Plan>('/api/v1/platform/plans', { method: 'POST', body })
        : platformApi<Plan>(`/api/v1/platform/plans/${editing.id}`, {
            method: 'PATCH',
            body,
          }),
    onSuccess: () => {
      refresh();
      setEditing(null);
    },
  });
  const toggle = useMutation({
    mutationFn: (plan: Plan) =>
      platformApi<Plan>(`/api/v1/platform/plans/${plan.id}`, {
        method: 'PATCH',
        body: { isActive: !plan.isActive },
      }),
    onSuccess: refresh,
    onSettled: () => setDeactivating(null),
  });

  useEffect(() => {
    save.reset();
    setInvalid(false);
    if (editing === null) return;
    const plan = editing === 'new' ? undefined : editing;
    setCode(plan?.code ?? '');
    setName(plan?.name ?? '');
    setCurrency(plan?.currency ?? 'UZS');
    setPrice(plan ? moneyInputText(plan.priceMinor, plan.currency) : '');
    setPeriod(String(plan?.periodDays ?? 30));
    setMaxOperators(
      plan?.limits?.maxOperators !== undefined
        ? String(plan.limits.maxOperators)
        : '',
    );
    setMaxChannels(
      plan?.limits?.maxChannelAccounts !== undefined
        ? String(plan.limits.maxChannelAccounts)
        : '',
    );
  }, [editing]);

  const isNew = editing === 'new';
  const priceMinor = /^[A-Z]{3}$/u.test(currency)
    ? parseMoneyInput(price, currency)
    : undefined;
  const periodDays = Number(period);
  const operators = optionalInt(maxOperators);
  const channels = optionalInt(maxChannels);
  const valid =
    (!isNew || CODE.test(code)) &&
    name.trim().length > 0 &&
    priceMinor !== undefined &&
    Number.isInteger(periodDays) &&
    periodDays >= 1 &&
    periodDays <= 3660 &&
    operators !== null &&
    channels !== null;

  function submit(): void {
    if (!valid || priceMinor === undefined) {
      setInvalid(true);
      return;
    }
    if (save.isPending) return;
    const previous =
      editing !== 'new' && editing !== null ? (editing.limits ?? {}) : {};
    const limits: PlanLimits = { ...previous };
    delete limits.maxOperators;
    delete limits.maxChannelAccounts;
    if (operators !== undefined && operators !== null)
      limits.maxOperators = operators;
    if (channels !== undefined && channels !== null)
      limits.maxChannelAccounts = channels;
    save.mutate({
      ...(isNew ? { code, currency } : {}),
      name: name.trim(),
      priceMinor,
      periodDays,
      limits,
    });
  }

  const plans = query.data?.plans ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{t('console.plans.intro')}</p>
        {canWrite ? (
          <Button
            variant="primary"
            icon="plus"
            data-testid="plan-new"
            onClick={() => setEditing('new')}
          >
            {t('console.plans.new')}
          </Button>
        ) : null}
      </div>
      <QueryState
        pending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      {query.isSuccess && plans.length === 0 ? (
        <EmptyState icon="database" text={t('console.plans.empty')} />
      ) : null}
      <ErrorNote error={toggle.error} />
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {plans.map((plan) => (
          <li
            key={plan.id}
            data-testid="plan-row"
            data-code={plan.code}
            className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-semibold">{plan.name}</span>
                <span className="truncate font-mono text-xs text-muted">
                  {plan.code}
                </span>
              </span>
              <Badge tone={plan.isActive ? 'success' : 'neutral'} dot>
                {plan.isActive
                  ? t('console.plans.active')
                  : t('console.plans.inactive')}
              </Badge>
            </div>
            <dl className="grid grid-cols-2 gap-3">
              <Field label={t('console.plans.price')} testId="plan-price">
                {formatMoney(plan.priceMinor, plan.currency, locale)}
              </Field>
              <Field label={t('console.plans.period')}>
                {t('console.plans.days', { days: plan.periodDays })}
              </Field>
              <Field label={t('console.plans.maxOperators')}>
                {plan.limits?.maxOperators ?? t('console.plans.unlimited')}
              </Field>
              <Field label={t('console.plans.maxChannels')}>
                {plan.limits?.maxChannelAccounts ??
                  t('console.plans.unlimited')}
              </Field>
            </dl>
            {canWrite ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  icon="pencil"
                  data-testid="plan-edit"
                  onClick={() => setEditing(plan)}
                >
                  {t('console.plans.edit')}
                </Button>
                {plan.isActive ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="plan-deactivate"
                    onClick={() => setDeactivating(plan)}
                  >
                    {t('console.plans.deactivate')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={toggle.isPending}
                    data-testid="plan-activate"
                    onClick={() => toggle.mutate(plan)}
                  >
                    {t('console.plans.activate')}
                  </Button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {canWrite ? (
        <>
          <FormDialog
            open={editing !== null}
            title={isNew ? t('console.plans.new') : t('console.plans.edit')}
            description={t('console.plans.formHint')}
            testId="plan-dialog"
            onClose={() => setEditing(null)}
            onSubmit={submit}
            footer={
              <>
                <Button onClick={() => setEditing(null)}>
                  {t('confirm.cancel')}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={save.isPending}
                  data-testid="plan-save"
                >
                  {t('app.save')}
                </Button>
              </>
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('console.plans.code')}
                <input
                  data-testid="plan-code"
                  required
                  disabled={!isNew}
                  maxLength={60}
                  autoCapitalize="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value.toLowerCase())}
                  aria-invalid={
                    invalid && isNew && !CODE.test(code) ? true : undefined
                  }
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('console.plans.name')}
                <input
                  data-testid="plan-name"
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('console.plans.price')}
                <input
                  data-testid="plan-price-input"
                  inputMode="decimal"
                  required
                  maxLength={20}
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  aria-invalid={
                    invalid && priceMinor === undefined ? true : undefined
                  }
                  className={fieldClass}
                />
                <span className="text-xs font-normal text-muted">
                  {priceMinor !== undefined
                    ? t('console.payments.preview', {
                        amount: formatMoney(priceMinor, currency, locale),
                      })
                    : t('console.payments.amountHint')}
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('console.payments.currency')}
                <input
                  data-testid="plan-currency"
                  required
                  disabled={!isNew}
                  maxLength={3}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('console.plans.periodDays')}
                <input
                  data-testid="plan-period"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={3660}
                  required
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('console.plans.maxOperators')}
                <input
                  data-testid="plan-max-operators"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={maxOperators}
                  onChange={(e) => setMaxOperators(e.target.value)}
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                {t('console.plans.maxChannels')}
                <input
                  data-testid="plan-max-channels"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={maxChannels}
                  onChange={(e) => setMaxChannels(e.target.value)}
                  className={fieldClass}
                />
                <span className="text-xs font-normal text-muted">
                  {t('console.plans.limitHint')}
                </span>
              </label>
            </div>
            {invalid && !valid ? (
              <p
                role="alert"
                className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
              >
                {t('console.formInvalid')}
              </p>
            ) : null}
            <ErrorNote error={save.error} />
          </FormDialog>
          <ConfirmDialog
            open={deactivating !== null}
            title={t('console.plans.deactivateTitle')}
            body={t('console.plans.deactivateBody', {
              name: deactivating?.name ?? '',
            })}
            confirmLabel={t('console.plans.deactivate')}
            cancelLabel={t('confirm.cancel')}
            tone="danger"
            busy={toggle.isPending}
            onConfirm={() => {
              if (deactivating && !toggle.isPending)
                toggle.mutate(deactivating);
            }}
            onCancel={() => setDeactivating(null)}
          />
        </>
      ) : null}
    </div>
  );
}
