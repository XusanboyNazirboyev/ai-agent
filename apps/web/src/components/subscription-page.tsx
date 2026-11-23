'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/money';
import { canManageTeam } from '@/lib/roles';
import type { OwnSubscription } from '@/lib/types';
import { useShell } from './app-shell';
import { SubscriptionBadge } from './console/console-format';
import { SubscriptionPay } from './subscription-pay';
import { EmptyState, QueryState } from './ui/error-note';
import { Icon } from './ui/icons';

function Row(props: {
  label: string;
  testId?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <dt className="text-sm text-muted">{props.label}</dt>
      <dd
        data-testid={props.testId}
        className="min-w-0 text-sm font-medium break-words"
      >
        {props.children}
      </dd>
    </div>
  );
}

/**
 * Settings → Subscription (ADR 047 §5): read-only. Plans, periods and
 * payments are managed by tezda in the platform console.
 */
/** Whole days until the period ends, never below zero (rounded up). */
export function daysLeft(end: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(end) - now) / 86_400_000));
}

export function SubscriptionPage(): ReactNode {
  const { t, locale } = useI18n();
  const { operator } = useShell();
  const manager = canManageTeam(operator.role);
  const query = useQuery({
    queryKey: ['subscription'],
    queryFn: () => api<OwnSubscription>('/api/v1/subscription'),
    enabled: manager,
  });
  const data = query.data;
  const subscription = data?.subscription ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('nav.billing')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
          {!manager ? (
            <p role="status" className="text-sm text-muted">
              {t('team.managersOnly')}
            </p>
          ) : null}
          {manager ? (
            <>
              <p className="text-sm text-muted">{t('subscription.intro')}</p>
              <QueryState
                pending={query.isPending}
                error={query.error}
                onRetry={() => void query.refetch()}
              />
            </>
          ) : null}
          {data ? (
            <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5">
              <h2 className="flex items-center gap-2 font-semibold">
                <Icon name="clock" className="h-5 w-5 text-muted" />
                {t('subscription.current')}
              </h2>
              {subscription ? (
                <dl className="flex flex-col gap-3">
                  <Row label={t('console.field.plan')} testId="own-plan">
                    {subscription.planName}
                  </Row>
                  <Row label={t('console.plans.price')}>
                    {t('subscription.pricePer', {
                      price: formatMoney(
                        subscription.priceMinor,
                        subscription.currency,
                        locale,
                      ),
                      days: subscription.periodDays,
                    })}
                  </Row>
                  <Row label={t('console.field.status')} testId="own-status">
                    <SubscriptionBadge status={subscription.status} />
                  </Row>
                  {/* Owner 2026-11-23: from when to when, and how long is left. */}
                  <Row label={t('subscription.period')} testId="own-period">
                    {formatDate(subscription.currentPeriodStart, locale)} –{' '}
                    {formatDate(subscription.currentPeriodEnd, locale)}
                  </Row>
                  <Row label={t('subscription.left')} testId="own-days-left">
                    {t('subscription.daysLeft', {
                      days: daysLeft(subscription.currentPeriodEnd, Date.now()),
                    })}
                  </Row>
                  {subscription.graceUntil ? (
                    <Row label={t('console.field.graceUntil')}>
                      {formatDate(subscription.graceUntil, locale)}
                    </Row>
                  ) : null}
                </dl>
              ) : (
                <p className="text-sm text-muted" data-testid="own-none">
                  {t('subscription.none')}
                </p>
              )}
              <p className="text-sm text-muted">
                {data.access.state === 'ok'
                  ? t('subscription.botOn')
                  : t('banner.expired')}
              </p>
            </section>
          ) : null}
          {data && data.plans.length > 0 ? (
            <section
              aria-labelledby="own-plans"
              data-testid="own-plans"
              className="flex flex-col gap-3"
            >
              <h2 id="own-plans" className="font-semibold">
                {t('subscription.plans')}
              </h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.plans.map((plan) => (
                  <li
                    key={plan.code}
                    data-testid="own-plan-option"
                    className={`flex flex-col gap-1 rounded-xl border p-3 text-sm ${
                      plan.code === data.currentPlanCode
                        ? 'border-primary bg-primary-soft'
                        : 'border-line bg-surface'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2 font-semibold">
                      {plan.name}
                      {plan.code === data.currentPlanCode ? (
                        <span className="text-xs font-medium text-primary-fg">
                          {t('subscription.currentPlan')}
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums">
                      {t('subscription.pricePer', {
                        price: formatMoney(
                          plan.priceMinor,
                          plan.currency,
                          locale,
                        ),
                        days: plan.periodDays,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data ? (
            <SubscriptionPay data={data} refetch={() => void query.refetch()} />
          ) : null}
          {data ? (
            <section
              aria-labelledby="own-payments"
              className="flex flex-col gap-3"
            >
              <h2 id="own-payments" className="font-semibold">
                {t('console.payments.title')}
              </h2>
              {data.payments.length === 0 ? (
                <EmptyState
                  icon="database"
                  text={t('console.payments.empty')}
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.payments.map((payment) => (
                    <li
                      key={payment.id}
                      data-testid="own-payment"
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-3 text-sm"
                    >
                      <span className="flex flex-col">
                        <span className="font-semibold tabular-nums">
                          {formatMoney(
                            payment.amountMinor,
                            payment.currency,
                            locale,
                          )}
                        </span>
                        <span className="text-xs text-muted">
                          {formatDate(
                            payment.paidAt ?? payment.createdAt,
                            locale,
                          )}
                        </span>
                      </span>
                      <span className="text-xs font-medium">
                        {t(`paymentStatus.${payment.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
