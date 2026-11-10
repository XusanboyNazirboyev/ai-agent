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
import { SettingsSubPage } from './settings-section-nav';
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
    <SettingsSubPage active="subscription">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('settings.section.subscription')}
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
                  <Row label={t('console.field.periodEnd')}>
                    {formatDate(subscription.currentPeriodEnd, locale)}
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
    </SettingsSubPage>
  );
}
