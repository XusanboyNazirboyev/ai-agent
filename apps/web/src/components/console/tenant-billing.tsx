'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import { formatDate, formatMoney, parseMoneyInput } from '@/lib/money';
import type {
  Plan,
  PlatformPayment,
  SubscriptionHistory,
} from '@/lib/platform-types';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { EmptyState, ErrorNote, QueryState } from '../ui/error-note';
import { fieldClass } from '../ui/fields';
import { FormDialog } from '../ui/form-dialog';
import { ReasonDialog } from '../ui/reason-dialog';
import { Select } from '../ui/select';
import { Card, Field, SubscriptionBadge } from './console-format';
import { useConsole } from './console-shell';

type Dialog = 'start' | 'change' | 'extend' | 'cancel' | null;

function usePlans(enabled: boolean): Plan[] {
  const plans = useQuery({
    queryKey: ['platform', 'plans'],
    queryFn: () => platformApi<{ plans: Plan[] }>('/api/v1/platform/plans'),
    enabled,
  });
  return (plans.data?.plans ?? []).filter((plan) => plan.isActive);
}

/** Subscription card of a customer: start, change plan, extend, cancel. */
export function SubscriptionCard(props: { tenantId: string }): ReactNode {
  const { t, locale } = useI18n();
  const { canWrite } = useConsole();
  const queryClient = useQueryClient();
  const base = `/api/v1/platform/tenants/${props.tenantId}`;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [planId, setPlanId] = useState('');
  const [trialDays, setTrialDays] = useState('');
  const plans = usePlans(canWrite);

  const query = useQuery({
    queryKey: ['platform', 'tenant', props.tenantId, 'subscription'],
    queryFn: () => platformApi<SubscriptionHistory>(`${base}/subscription`),
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: ['platform', 'tenant', props.tenantId],
    });
    void queryClient.invalidateQueries({ queryKey: ['platform', 'tenants'] });
  };
  const write = useMutation({
    mutationFn: (input: { path: string; body: unknown }) =>
      platformApi(`${base}/subscription${input.path}`, {
        method: 'POST',
        body: input.body,
      }),
    onSuccess: () => {
      refresh();
      setDialog(null);
    },
  });
  // Extending is a one-click confirm; its answer is shown on the card.
  const extend = useMutation({
    mutationFn: () =>
      platformApi(`${base}/subscription/extend`, { method: 'POST', body: {} }),
    onSuccess: refresh,
    onSettled: () => setDialog(null),
  });
  useEffect(() => {
    if (dialog === 'extend') extend.reset();
    if (dialog === null) {
      write.reset();
      setTrialDays('');
    }
    if (dialog === 'start' || dialog === 'change')
      setPlanId(
        query.data?.current?.planId &&
          plans.some((plan) => plan.id === query.data?.current?.planId)
          ? query.data.current.planId
          : (plans[0]?.id ?? ''),
      );
    // Only when a dialog opens or closes.
  }, [dialog]);

  const current = query.data?.current ?? null;
  const trial = trialDays === '' ? undefined : Number(trialDays);
  const trialValid =
    trial === undefined ||
    (Number.isInteger(trial) && trial >= 1 && trial <= 365);
  const chosen = plans.find((plan) => plan.id === planId);

  function planSelect(): ReactNode {
    return (
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t('console.field.plan')}
        <Select
          data-testid="subscription-plan"
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
        >
          {plans.map((plan) => (
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
    );
  }

  return (
    <Card
      title={t('console.subscription.title')}
      testId="subscription-card"
      actions={
        canWrite && query.isSuccess ? (
          current ? (
            <>
              <Button
                size="sm"
                data-testid="subscription-change"
                onClick={() => setDialog('change')}
              >
                {t('console.subscription.change')}
              </Button>
              <Button
                size="sm"
                data-testid="subscription-extend"
                onClick={() => setDialog('extend')}
              >
                {t('console.subscription.extend')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                data-testid="subscription-cancel"
                onClick={() => setDialog('cancel')}
              >
                {t('console.subscription.cancel')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              data-testid="subscription-start"
              onClick={() => setDialog('start')}
            >
              {t('console.subscription.start')}
            </Button>
          )
        ) : undefined
      }
    >
      <QueryState
        pending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      {query.isSuccess && !current ? (
        <p className="text-sm text-muted" data-testid="subscription-none">
          {t('console.subscription.none')}
        </p>
      ) : null}
      {current ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Field label={t('console.field.plan')}>{current.planName}</Field>
          <Field label={t('console.field.status')} testId="subscription-status">
            <SubscriptionBadge status={current.status} />
          </Field>
          <Field
            label={t('console.field.periodEnd')}
            testId="subscription-period-end"
          >
            {formatDate(current.currentPeriodEnd, locale)}
          </Field>
          <Field label={t('console.field.graceUntil')}>
            {current.graceUntil ? formatDate(current.graceUntil, locale) : '—'}
          </Field>
        </dl>
      ) : null}
      {query.data && query.data.history.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer rounded-lg font-medium text-primary-fg">
            {t('console.subscription.history', {
              count: query.data.history.length,
            })}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {query.data.history.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-2 border-t border-line pt-1.5"
              >
                <SubscriptionBadge status={row.status} />
                <span>{row.planName}</span>
                <span className="text-muted">
                  {t('console.subscription.period', {
                    start: formatDate(row.currentPeriodStart, locale),
                    end: formatDate(row.currentPeriodEnd, locale),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canWrite ? (
        <>
          <FormDialog
            open={dialog === 'start' || dialog === 'change'}
            title={
              dialog === 'change'
                ? t('console.subscription.changeTitle')
                : t('console.subscription.startTitle')
            }
            description={
              dialog === 'change'
                ? t('console.subscription.changeBody')
                : t('console.subscription.startBody')
            }
            testId="subscription-dialog"
            onClose={() => setDialog(null)}
            onSubmit={() => {
              if (!planId || !trialValid || write.isPending) return;
              write.mutate(
                dialog === 'change'
                  ? { path: '/change-plan', body: { planId } }
                  : {
                      path: '',
                      body: { planId, ...(trial ? { trialDays: trial } : {}) },
                    },
              );
            }}
            footer={
              <>
                <Button onClick={() => setDialog(null)}>
                  {t('confirm.cancel')}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={write.isPending}
                  disabled={!planId || !trialValid}
                  data-testid="subscription-submit"
                >
                  {dialog === 'change'
                    ? t('console.subscription.change')
                    : t('console.subscription.start')}
                </Button>
              </>
            }
          >
            {plans.length === 0 ? (
              <p className="text-sm text-muted">
                {t('console.subscription.noPlans')}
              </p>
            ) : (
              planSelect()
            )}
            {dialog === 'start' ? (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('console.field.trialDays')}
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  data-testid="subscription-trial"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                  aria-invalid={!trialValid ? true : undefined}
                  className={fieldClass}
                />
                <span className="text-xs font-normal text-muted">
                  {t('console.field.trialHint')}
                </span>
              </label>
            ) : null}
            {chosen && dialog === 'start' && !trial ? (
              <p className="text-sm text-muted">
                {t('console.subscription.startsFor', {
                  days: chosen.periodDays,
                })}
              </p>
            ) : null}
            <ErrorNote error={write.error} />
          </FormDialog>
          <ConfirmDialog
            open={dialog === 'extend'}
            title={t('console.subscription.extendTitle')}
            body={t('console.subscription.extendBody')}
            confirmLabel={t('console.subscription.extend')}
            cancelLabel={t('confirm.cancel')}
            busy={extend.isPending}
            onConfirm={() => {
              if (!extend.isPending) extend.mutate();
            }}
            onCancel={() => setDialog(null)}
          />
          <ErrorNote error={extend.error} testId="extend-error" />
          <ReasonDialog
            open={dialog === 'cancel'}
            title={t('console.subscription.cancelTitle')}
            body={t('console.subscription.cancelBody')}
            confirmLabel={t('console.subscription.cancel')}
            tone="danger"
            busy={write.isPending}
            error={write.error}
            onConfirm={(reason) =>
              write.mutate({ path: '/cancel', body: { reason } })
            }
            onCancel={() => setDialog(null)}
          />
        </>
      ) : null}
    </Card>
  );
}

/** Payment history of a customer and the "record manual payment" form. */
export function PaymentsCard(props: {
  tenantId: string;
  hasOpenSubscription: boolean;
}): ReactNode {
  const { t, locale } = useI18n();
  const { canWrite } = useConsole();
  const queryClient = useQueryClient();
  const base = `/api/v1/platform/tenants/${props.tenantId}`;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('UZS');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [extend, setExtend] = useState(true);
  const [invalid, setInvalid] = useState(false);

  const query = useQuery({
    queryKey: ['platform', 'tenant', props.tenantId, 'payments'],
    queryFn: () =>
      platformApi<{ payments: PlatformPayment[] }>(`${base}/payments`),
  });
  const record = useMutation({
    mutationFn: (amountMinor: number) =>
      platformApi(`${base}/payments`, {
        method: 'POST',
        body: {
          amountMinor,
          currency,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          extendSubscription: extend && props.hasOpenSubscription,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['platform', 'tenant', props.tenantId],
      });
      void queryClient.invalidateQueries({ queryKey: ['platform', 'tenants'] });
      setOpen(false);
    },
  });
  useEffect(() => {
    if (open) return;
    setAmount('');
    setReference('');
    setNote('');
    setExtend(true);
    setInvalid(false);
    record.reset();
  }, [open]);

  const currencyValid = /^[A-Z]{3}$/u.test(currency);
  const parsed = currencyValid ? parseMoneyInput(amount, currency) : undefined;
  const payments = query.data?.payments ?? [];

  return (
    <Card
      title={t('console.payments.title')}
      testId="payments-card"
      actions={
        canWrite ? (
          <Button
            size="sm"
            icon="plus"
            data-testid="payment-record"
            onClick={() => setOpen(true)}
          >
            {t('console.payments.record')}
          </Button>
        ) : undefined
      }
    >
      <QueryState
        pending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      {query.isSuccess && payments.length === 0 ? (
        <EmptyState icon="database" text={t('console.payments.empty')} />
      ) : null}
      <ul className="flex flex-col gap-2">
        {payments.map((payment) => (
          <li
            key={payment.id}
            data-testid="payment-row"
            className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 first:border-t-0 first:pt-0 text-sm"
          >
            <span className="flex min-w-0 flex-col">
              <span className="font-semibold tabular-nums">
                {formatMoney(payment.amountMinor, payment.currency, locale)}
              </span>
              <span className="text-xs text-muted">
                {t(`paymentProvider.${payment.provider}`)}
                {' · '}
                {formatDate(payment.paidAt ?? payment.createdAt, locale)}
                {payment.recordedBy ? ` · ${payment.recordedBy}` : ''}
              </span>
              {payment.summary?.note ? (
                <span className="text-xs break-words text-muted">
                  {payment.summary.note}
                </span>
              ) : null}
            </span>
            <span className="text-xs font-medium">
              {t(`paymentStatus.${payment.status}`)}
            </span>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <FormDialog
          open={open}
          title={t('console.payments.recordTitle')}
          description={t('console.payments.recordBody')}
          testId="payment-dialog"
          onClose={() => setOpen(false)}
          onSubmit={() => {
            if (parsed === undefined || parsed <= 0) {
              setInvalid(true);
              return;
            }
            if (!record.isPending) record.mutate(parsed);
          }}
          footer={
            <>
              <Button onClick={() => setOpen(false)}>
                {t('confirm.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={record.isPending}
                data-testid="payment-submit"
              >
                {t('console.payments.save')}
              </Button>
            </>
          }
        >
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              {t('console.payments.amount')}
              <input
                data-testid="payment-amount"
                inputMode="decimal"
                required
                maxLength={20}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={
                  invalid && parsed === undefined ? true : undefined
                }
                className={fieldClass}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              {t('console.payments.currency')}
              <input
                data-testid="payment-currency"
                required
                maxLength={3}
                autoCapitalize="characters"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                aria-invalid={!currencyValid ? true : undefined}
                className={fieldClass}
              />
            </label>
          </div>
          <p className="text-sm text-muted" data-testid="payment-preview">
            {parsed !== undefined && parsed > 0
              ? t('console.payments.preview', {
                  amount: formatMoney(parsed, currency, locale),
                })
              : t('console.payments.amountHint')}
          </p>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('console.payments.reference')}
            <input
              data-testid="payment-reference"
              maxLength={120}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('console.payments.note')}
            <input
              data-testid="payment-note"
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="payment-extend"
              checked={extend && props.hasOpenSubscription}
              disabled={!props.hasOpenSubscription}
              onChange={(e) => setExtend(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
            />
            <span>
              {props.hasOpenSubscription
                ? t('console.payments.extend')
                : t('console.payments.noOpen')}
            </span>
          </label>
          {invalid && (parsed === undefined || parsed <= 0) ? (
            <p
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
            >
              {t('console.payments.amountInvalid')}
            </p>
          ) : null}
          <ErrorNote error={record.error} />
        </FormDialog>
      ) : null}
    </Card>
  );
}
