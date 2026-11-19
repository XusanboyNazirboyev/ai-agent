'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import { formatDecimalMoney, formatUsd } from '@/lib/money';
import type {
  DecimalMoney,
  OverviewMonth,
  OverviewState,
  PlatformOverview,
} from '@/lib/platform-types';
import { EmptyState, QueryState } from '../ui/error-note';
import { Select } from '../ui/select';

const STATES: OverviewState[] = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'EXPIRED',
  'CANCELED',
  'NONE',
];

function stateLabel(t: (key: string) => string, state: OverviewState): string {
  return state === 'NONE'
    ? t('console.noSubscription')
    : t(`subscriptionStatus.${state}`);
}

/** Currencies that appear anywhere in the overview, biggest all-time first. */
function currenciesOf(data: PlatformOverview): string[] {
  const all = new Set<string>(Object.keys(data.revenue.allTime));
  for (const month of data.months)
    for (const currency of Object.keys(month.revenue)) all.add(currency);
  for (const currency of Object.keys(data.revenue.mrr)) all.add(currency);
  return [...all].sort(
    (a, b) =>
      Number(data.revenue.allTime[b] ?? 0) -
        Number(data.revenue.allTime[a] ?? 0) || a.localeCompare(b),
  );
}

function Money(props: { value: DecimalMoney }): ReactNode {
  const { locale } = useI18n();
  const entries = Object.entries(props.value);
  if (entries.length === 0) return <span>—</span>;
  return (
    <span className="flex min-w-0 flex-col">
      {entries.map(([currency, decimal]) => (
        <span key={currency} className="break-words">
          {formatDecimalMoney(decimal, currency, locale)}
        </span>
      ))}
    </span>
  );
}

function Tile(props: {
  testId: string;
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"
    >
      <dt className="text-base text-muted">{props.label}</dt>
      <dd className="min-w-0 text-3xl font-semibold sm:text-4xl tracking-tight">
        {props.children}
      </dd>
      {props.hint ? (
        <dd className="text-base text-muted">{props.hint}</dd>
      ) : null}
    </div>
  );
}

const W = 480;
const H = 240;
const PAD = { top: 8, bottom: 28, left: 4, right: 4 };

/**
 * Plain SVG bars, one group per month. Colour is never the only cue: each
 * series has a legend, and a screen-reader table carries the numbers.
 */
function BarChart(props: {
  testId: string;
  label: string;
  months: OverviewMonth[];
  series: { id: string; label: string; className: string; values: number[] }[];
  format: (value: number) => string;
}): ReactNode {
  const { locale } = useI18n();
  const max = Math.max(1, ...props.series.flatMap((s) => s.values));
  const group = (W - PAD.left - PAD.right) / Math.max(1, props.months.length);
  const bar = Math.max(2, (group * 0.7) / props.series.length);
  const plotH = H - PAD.top - PAD.bottom;
  const monthName = (key: string): string => {
    try {
      return new Intl.DateTimeFormat(
        locale === 'uz-Latn' ? 'uz-Latn' : locale,
        {
          month: 'short',
          timeZone: 'UTC',
        },
      ).format(new Date(`${key}-01T00:00:00Z`));
    } catch {
      return key.slice(5);
    }
  };
  return (
    <figure
      data-testid={props.testId}
      className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"
    >
      <figcaption className="text-lg font-semibold">{props.label}</figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-base text-muted">
        {props.series.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`inline-block h-2.5 w-2.5 rounded-sm ${s.className.replace('fill-', 'bg-')}`}
            />
            {s.label}
          </li>
        ))}
      </ul>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={props.label}
        className="h-auto w-full"
      >
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          className="stroke-line"
        />
        {props.months.map((month, index) => {
          const x0 =
            PAD.left + index * group + (group - bar * props.series.length) / 2;
          return (
            <g key={month.month}>
              {props.series.map((s, k) => {
                const value = s.values[index] ?? 0;
                const h = (value / max) * plotH;
                return (
                  <rect
                    key={s.id}
                    x={x0 + k * bar}
                    y={H - PAD.bottom - h}
                    width={bar - 1}
                    height={h}
                    rx={1.5}
                    className={s.className}
                  >
                    <title>{`${monthName(month.month)}: ${props.format(value)}`}</title>
                  </rect>
                );
              })}
              <text
                x={PAD.left + index * group + group / 2}
                y={H - 6}
                textAnchor="middle"
                className="fill-muted text-[13px]"
              >
                {monthName(month.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{props.label}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {props.series.map((s) => (
              <th key={s.id} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.months.map((month, index) => (
            <tr key={month.month}>
              <th scope="row">{month.month}</th>
              {props.series.map((s) => (
                <td key={s.id}>{props.format(s.values[index] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The platform's business overview: who joins, trials, leaves, and pays. */
export function ConsoleOverview(): ReactNode {
  const { t, locale, formatDateTime } = useI18n();
  const query = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: () =>
      platformApi<PlatformOverview>('/api/v1/platform/overview?months=12'),
  });
  const [picked, setPicked] = useState('');
  const data = query.data;
  const currencies = data ? currenciesOf(data) : [];
  const currency = currencies.includes(picked) ? picked : (currencies[0] ?? '');
  const thisMonth = data?.months[data.months.length - 1];

  return (
    <div className="flex flex-col gap-8" data-testid="overview">
      <QueryState
        pending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      {data ? (
        data.companies.total === 0 ? (
          <EmptyState icon="users" text={t('console.overview.empty')} />
        ) : (
          <>
            <dl
              aria-label={t('console.overview.kpis')}
              className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4"
            >
              <Tile
                testId="kpi-companies"
                label={t('console.overview.kpi.companies')}
              >
                {data.companies.total}
              </Tile>
              <Tile
                testId="kpi-paying"
                label={t('console.overview.kpi.paying')}
              >
                {data.companies.bySubscription.ACTIVE}
              </Tile>
              <Tile testId="kpi-trial" label={t('console.overview.kpi.trial')}>
                {data.companies.bySubscription.TRIAL}
              </Tile>
              <Tile
                testId="kpi-trial-soon"
                label={t('console.overview.kpi.trialSoon')}
              >
                {data.trialsEndingSoon}
              </Tile>
              <Tile
                testId="kpi-churned"
                label={t('console.overview.kpi.churned')}
              >
                {thisMonth?.churned ?? 0}
              </Tile>
              <Tile
                testId="kpi-revenue"
                label={t('console.overview.kpi.revenueMonth')}
              >
                <Money value={data.revenue.thisMonth} />
              </Tile>
              <Tile
                testId="kpi-mrr"
                label={t('console.overview.kpi.mrr')}
                hint={t('console.overview.kpi.mrrHint')}
              >
                <Money value={data.revenue.mrr} />
              </Tile>
              <Tile
                testId="kpi-revenue-all"
                label={t('console.overview.kpi.revenueAll')}
              >
                <Money value={data.revenue.allTime} />
              </Tile>
            </dl>

            <div className="grid gap-6 lg:grid-cols-2">
              <BarChart
                testId="chart-companies"
                label={t('console.overview.chart.companies')}
                months={data.months}
                series={[
                  {
                    id: 'new',
                    label: t('console.overview.chart.new'),
                    className: 'fill-primary',
                    values: data.months.map((m) => m.newCompanies),
                  },
                  {
                    id: 'churned',
                    label: t('console.overview.chart.churned'),
                    className: 'fill-danger',
                    values: data.months.map((m) => m.churned),
                  },
                ]}
                format={(value) => String(value)}
              />
              <div className="flex min-w-0 flex-col gap-2">
                {currencies.length > 1 ? (
                  <Select
                    aria-label={t('console.overview.chart.currency')}
                    data-testid="overview-currency"
                    value={currency}
                    onChange={(e) => setPicked(e.target.value)}
                  >
                    {currencies.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </Select>
                ) : null}
                <BarChart
                  testId="chart-revenue"
                  label={t('console.overview.chart.revenue', {
                    currency: currency || '—',
                  })}
                  months={data.months}
                  series={[
                    {
                      id: 'revenue',
                      label: t('console.overview.chart.revenueSeries'),
                      className: 'fill-primary',
                      values: data.months.map((m) =>
                        Number(m.revenue[currency] ?? 0),
                      ),
                    },
                  ]}
                  format={(value) =>
                    currency
                      ? formatDecimalMoney(value.toFixed(2), currency, locale)
                      : String(value)
                  }
                />
              </div>
            </div>

            <section
              aria-labelledby="overview-states"
              className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"
            >
              <h2 id="overview-states" className="text-lg font-semibold">
                {t('console.overview.states.title')}
              </h2>
              <p className="text-base text-muted">
                {t('console.overview.states.hint')}
              </p>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                {STATES.map((state) => (
                  <li key={state}>
                    <Link
                      href={`/console?subscription=${state}`}
                      data-testid={`state-${state}`}
                      className="flex min-h-20 flex-col rounded-xl border border-line px-5 py-4 hover:bg-surface-2"
                    >
                      <span className="text-base text-muted">
                        {stateLabel(t, state)}
                      </span>
                      <span className="text-3xl font-semibold">
                        {data.companies.bySubscription[state]}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <section
                aria-labelledby="overview-usage"
                className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"
              >
                <h2 id="overview-usage" className="text-lg font-semibold">
                  {t('console.overview.usage.title')}
                </h2>
                <dl className="grid grid-cols-3 gap-4 text-base">
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-base text-muted">
                      {t('console.overview.usage.conversations')}
                    </dt>
                    <dd className="text-2xl font-semibold">
                      {data.usageThisMonth.conversations}
                    </dd>
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-base text-muted">
                      {t('console.overview.usage.inbound')}
                    </dt>
                    <dd className="text-2xl font-semibold">
                      {data.usageThisMonth.inboundMessages}
                    </dd>
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-base text-muted">
                      {t('console.overview.usage.llmCost')}
                    </dt>
                    <dd className="text-2xl font-semibold">
                      {formatUsd(data.usageThisMonth.llmCostUsd, locale)}
                    </dd>
                  </div>
                </dl>
                <p className="text-base text-muted">
                  {t('console.overview.usage.active', {
                    count: thisMonth?.activeCompanies ?? 0,
                  })}
                </p>
              </section>

              <section
                aria-labelledby="overview-recent"
                className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6"
              >
                <h2 id="overview-recent" className="text-lg font-semibold">
                  {t('console.overview.recent.title')}
                </h2>
                {data.recent.length === 0 ? (
                  <p className="text-base text-muted">
                    {t('console.overview.recent.empty')}
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-line">
                    {data.recent.map((event) => (
                      <li
                        key={event.id}
                        data-testid="recent-event"
                        className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 py-3 text-lg"
                      >
                        <Link
                          href={`/console/tenants/${event.tenantId}`}
                          className="min-w-0 truncate font-medium hover:underline"
                        >
                          {event.tenantName}
                        </Link>
                        <span className="text-muted">
                          {eventLabel(t, event.kind)}
                          {' · '}
                          {formatDateTime(event.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

const EVENT_KINDS = [
  'tenant.created',
  'subscription.started',
  'subscription.plan_changed',
  'subscription.extended',
  'subscription.canceled',
  'subscription.expired',
  'payment.recorded',
];

function eventLabel(t: (key: string) => string, kind: string): string {
  return EVENT_KINDS.includes(kind)
    ? t(`console.overview.event.${kind}`)
    : kind;
}
