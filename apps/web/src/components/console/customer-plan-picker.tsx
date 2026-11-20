'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import type { Plan } from '@/lib/platform-types';
import { Button } from '../ui/button';
import { QueryState } from '../ui/error-note';
import { fieldClass } from '../ui/fields';
import { Select } from '../ui/select';

interface PlanPage {
  plans: Plan[];
  nextCursor: string | null;
}

/** Search every active plan; keep the choice visible when the search changes. */
export function CustomerPlanPicker(props: {
  value: Plan | null;
  onChange: (plan: Plan | null) => void;
}): ReactNode {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(draft.trim()), 300);
    return () => clearTimeout(timer);
  }, [draft]);
  const plans = useInfiniteQuery({
    queryKey: ['platform', 'plans', 'available', search],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ q: search, limit: '25' });
      if (pageParam) params.set('cursor', pageParam);
      return platformApi<PlanPage>(
        `/api/v1/platform/plans/available?${params}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const results = plans.data?.pages.flatMap((page) => page.plans) ?? [];
  const options =
    props.value && !results.some((plan) => plan.id === props.value?.id)
      ? [props.value, ...results]
      : results;
  const waitingForSearch = draft.trim() !== search;

  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t('console.newCustomer.planSearch')}
        <input
          type="search"
          data-testid="customer-plan-search"
          maxLength={200}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className={fieldClass}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t('console.field.plan')}
        <Select
          data-testid="customer-plan"
          value={props.value?.id ?? ''}
          disabled={waitingForSearch || plans.isPending}
          onChange={(event) =>
            props.onChange(
              options.find((plan) => plan.id === event.target.value) ?? null,
            )
          }
        >
          <option value="">{t('console.field.noPlan')}</option>
          {options.map((plan) => (
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
      <QueryState
        pending={plans.isPending || waitingForSearch}
        error={plans.error}
        onRetry={() => {
          void (plans.isFetchNextPageError
            ? plans.fetchNextPage()
            : plans.refetch());
        }}
      />
      {plans.isSuccess && !waitingForSearch && results.length === 0 ? (
        <p role="status" className="text-sm text-muted">
          {t('console.newCustomer.noMatchingPlans')}
        </p>
      ) : null}
      {plans.hasNextPage ? (
        <Button
          data-testid="customer-plans-more"
          disabled={waitingForSearch || plans.isFetching}
          loading={plans.isFetchingNextPage}
          onClick={() => {
            void plans.fetchNextPage();
          }}
        >
          {t('list.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
