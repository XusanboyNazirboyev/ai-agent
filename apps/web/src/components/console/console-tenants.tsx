'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import { formatDate, formatUsd } from '@/lib/money';
import type { TenantRow, TenantStatus } from '@/lib/platform-types';
import {
  filterBySubscription,
  SUBSCRIPTION_FILTERS,
  type SubscriptionFilter,
} from '@/lib/subscription-filter';
import { useNow } from '@/lib/use-now';
import { Button } from '../ui/button';
import { EmptyState, QueryState } from '../ui/error-note';
import { fieldClass } from '../ui/fields';
import { Icon } from '../ui/icons';
import { Select } from '../ui/select';
import { Field, SubscriptionBadge, TenantStatusBadge } from './console-format';
import { TenantActions } from './tenant-actions';
import { useConsole } from './console-shell';
import { NewCustomerDialog } from './new-customer-dialog';

const STATUSES: TenantStatus[] = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'];

/** Every customer business with its plan, subscription and this month's usage. */
export function ConsoleTenants(): ReactNode {
  const { t, locale, formatDateTime } = useI18n();
  const { canWrite } = useConsole();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | TenantStatus>('');
  // The overview links here with ?subscription=<state>.
  const initial = useSearchParams().get('subscription') ?? '';
  const [subscription, setSubscription] = useState<'' | SubscriptionFilter>(
    (SUBSCRIPTION_FILTERS as readonly string[]).includes(initial)
      ? (initial as SubscriptionFilter)
      : '',
  );
  const now = useNow(60 * 60_000);
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());
  const churnSegment = subscription === 'CHURNED_THIS_MONTH';

  const query = useQuery({
    queryKey: ['platform', 'tenants', q, status, churnSegment],
    queryFn: () => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (churnSegment) params.set('segment', 'CHURNED_THIS_MONTH');
      return platformApi<{ tenants: TenantRow[] }>(
        `/api/v1/platform/tenants?${params.toString()}`,
      );
    },
  });
  // At most 500 rows come back, so the subscription filter runs here.
  const tenants = filterBySubscription(
    query.data?.tenants ?? [],
    subscription,
    now,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            <Icon name="search" />
          </span>
          <input
            type="search"
            data-testid="tenant-search"
            aria-label={t('console.tenants.search')}
            placeholder={t('console.tenants.search')}
            maxLength={100}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClass} pl-9`}
          />
        </div>
        <Select
          aria-label={t('console.tenants.statusFilter')}
          data-testid="tenant-status-filter"
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | TenantStatus)}
          className="sm:w-48"
        >
          <option value="">{t('console.tenants.allStatuses')}</option>
          {STATUSES.map((id) => (
            <option key={id} value={id}>
              {t(`tenantStatus.${id}`)}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('console.tenants.subscriptionFilter')}
          data-testid="tenant-subscription-filter"
          value={subscription}
          onChange={(e) =>
            setSubscription(e.target.value as '' | SubscriptionFilter)
          }
          className="sm:w-56"
        >
          <option value="">{t('console.tenants.allSubscriptions')}</option>
          {SUBSCRIPTION_FILTERS.map((id) => (
            <option key={id} value={id}>
              {id === 'ENDS_SOON'
                ? t('console.tenants.endsSoon')
                : id === 'TRIAL_ENDING_SOON'
                  ? t('console.overview.kpi.trialSoon')
                  : id === 'CHURNED_THIS_MONTH'
                    ? t('console.overview.kpi.churned')
                    : id === 'NONE'
                      ? t('console.noSubscription')
                      : t(`subscriptionStatus.${id}`)}
            </option>
          ))}
        </Select>
        {canWrite ? (
          <Button
            variant="primary"
            icon="plus"
            data-testid="new-customer"
            onClick={() => setCreating(true)}
          >
            {t('console.newCustomer.button')}
          </Button>
        ) : null}
      </div>

      <QueryState
        pending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      {query.isSuccess && tenants.length === 0 ? (
        <EmptyState
          icon="users"
          text={
            q || status || subscription
              ? t('console.tenants.emptyFiltered')
              : t('console.tenants.empty')
          }
        />
      ) : null}

      <ul className="flex flex-col gap-2" aria-label={t('console.nav.tenants')}>
        {tenants.map((tenant) => (
          <li
            key={tenant.id}
            data-testid="tenant-row"
            data-slug={tenant.slug}
            className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card sm:p-4"
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <Link
                href={`/console/tenants/${tenant.id}`}
                className="flex min-w-0 flex-col rounded-lg hover:underline"
              >
                <span className="truncate font-semibold">{tenant.name}</span>
                <span className="truncate font-mono text-xs text-muted">
                  {tenant.slug}
                </span>
              </Link>
              <span className="flex flex-wrap items-center gap-1.5">
                <TenantStatusBadge status={tenant.status} />
                <SubscriptionBadge status={tenant.subscription?.status} />
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 lg:grid-cols-7">
              <Field label={t('console.overview.tenants.created')}>
                {formatDate(tenant.createdAt, locale)}
              </Field>
              <Field label={t('console.overview.tenants.lastActivity')}>
                {tenant.lastInboundAt
                  ? formatDateTime(tenant.lastInboundAt)
                  : t('console.overview.tenants.noActivity')}
              </Field>
              <Field label={t('console.field.plan')}>
                {tenant.subscription?.planName ?? '—'}
              </Field>
              <Field label={t('console.field.periodEnd')}>
                {tenant.subscription
                  ? formatDate(tenant.subscription.currentPeriodEnd, locale)
                  : '—'}
              </Field>
              <Field label={t('console.usage.conversations')}>
                {tenant.usage.conversations}
              </Field>
              <Field label={t('console.usage.inbound')}>
                {tenant.usage.inboundMessages}
              </Field>
              <Field label={t('console.usage.llmCost')}>
                {formatUsd(tenant.usage.llmCostUsd, locale)}
              </Field>
            </dl>
            <TenantActions tenant={tenant} />
          </li>
        ))}
      </ul>
      {canWrite ? (
        <NewCustomerDialog open={creating} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}
