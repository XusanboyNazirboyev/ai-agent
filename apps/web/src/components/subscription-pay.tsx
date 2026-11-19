'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import type { OwnSubscription } from '@/lib/types';
import { Button } from './ui/button';

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 60_000;

/** What changes when the payment is confirmed. */
function signature(data: OwnSubscription): string {
  return `${data.subscription?.status ?? ''}|${data.subscription?.currentPeriodEnd ?? ''}`;
}

/**
 * "Pay with Click" (ADR 082). Prices are shown from the API's minor units;
 * the server builds the pay link and the amount. After the customer returns
 * (`?paid=1`) the page polls until the subscription changes, for up to 60 s.
 */
export function SubscriptionPay(props: {
  data: OwnSubscription;
  refetch: () => void;
  /** Test hook: the navigation to Click. */
  navigate?: (url: string) => void;
}): ReactNode {
  const { t, locale } = useI18n();
  const { data, refetch } = props;
  const plans = data.plans.filter((plan) => plan.currency === 'UZS');
  const [chosen, setChosen] = useState<string | undefined>();
  const selected =
    chosen ??
    plans.find((plan) => plan.code === data.currentPlanCode)?.code ??
    plans[0]?.code;
  const [returned, setReturned] = useState(false);
  const [waited, setWaited] = useState<'waiting' | 'done' | 'timeout'>(
    'waiting',
  );
  const baseline = useRef<string | undefined>(undefined);

  useEffect(() => {
    try {
      setReturned(new URLSearchParams(window.location.search).has('paid'));
    } catch {
      setReturned(false);
    }
  }, []);
  baseline.current ??= signature(data);
  const changed = signature(data) !== baseline.current;
  useEffect(() => {
    if (!returned || changed) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started >= POLL_LIMIT_MS) {
        clearInterval(timer);
        setWaited('timeout');
        return;
      }
      refetch();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [returned, changed, refetch]);
  useEffect(() => {
    if (returned && changed) setWaited('done');
  }, [returned, changed]);

  const pay = useMutation({
    mutationFn: (planCode: string) =>
      api<{ url: string }>('/api/v1/billing/click/checkout', {
        method: 'POST',
        body: { planCode },
      }),
    onSuccess: ({ url }) => {
      if (props.navigate) props.navigate(url);
      else window.location.assign(url);
    },
  });

  return (
    <section
      aria-labelledby="own-pay"
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <h2 id="own-pay" className="font-semibold">
        {t('billing.payTitle')}
      </h2>
      {returned ? (
        <p role="status" data-testid="pay-notice" className="text-sm">
          {waited === 'done'
            ? t('billing.confirmed')
            : waited === 'timeout'
              ? t('billing.stillWaiting')
              : t('billing.confirming')}
        </p>
      ) : null}
      {!data.clickConfigured ? (
        <p className="text-sm text-muted" data-testid="pay-unavailable">
          {t('billing.unavailable')}
        </p>
      ) : plans.length === 0 ? (
        <p className="text-sm text-muted">{t('billing.noPlans')}</p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm text-muted">
              {t('billing.pickPlan')}
            </legend>
            {plans.map((plan) => (
              <label
                key={plan.code}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-line p-3 text-sm"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="plan"
                    value={plan.code}
                    checked={selected === plan.code}
                    onChange={() => setChosen(plan.code)}
                  />
                  <span className="font-medium">{plan.name}</span>
                </span>
                <span className="tabular-nums">
                  {t('subscription.pricePer', {
                    price: formatMoney(plan.priceMinor, plan.currency, locale),
                    days: plan.periodDays,
                  })}
                </span>
              </label>
            ))}
          </fieldset>
          {pay.error ? (
            <p role="alert" className="text-sm text-danger-fg">
              {t(errorKey(pay.error))}
            </p>
          ) : null}
          <div>
            <Button
              variant="primary"
              data-testid="pay-click"
              disabled={!selected || pay.isPending || pay.isSuccess}
              onClick={() => selected && pay.mutate(selected)}
            >
              {pay.isPending || pay.isSuccess
                ? t('billing.redirecting')
                : t('billing.payWithClick')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
