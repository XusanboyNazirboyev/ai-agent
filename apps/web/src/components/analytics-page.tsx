'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import {
  metricFormat,
  presetRange,
  RANGE_PRESETS,
  type MetricFormat,
} from '@/lib/analytics';
import type { AnalyticsReport } from '@/lib/types';
import { useShell } from './app-shell';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { reasonLabel } from '@/lib/handover-text';

type Range = { from: string; to: string };

function Tile(props: {
  label: string;
  value: string;
  sub?: string;
  testId: string;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface p-4 shadow-card"
    >
      <span className="text-sm text-muted">{props.label}</span>
      <span className="text-2xl font-semibold tabular-nums break-words">
        {props.value}
      </span>
      {props.sub ? (
        <span className="text-xs text-muted break-words">{props.sub}</span>
      ) : null}
    </div>
  );
}

function Card(props: {
  title: string;
  testId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      data-testid={props.testId}
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <h2 className="font-semibold break-words">{props.title}</h2>
      {props.children}
    </section>
  );
}

/** One bar per calendar day; the table below carries the same numbers. */
function DailyBars(props: {
  title: string;
  testId: string;
  rows: { day: string; count: number }[];
  f: MetricFormat;
}): ReactNode {
  const { t } = useI18n();
  const { rows, f } = props;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const peak = rows.reduce(
    (best, row) => (row.count > best.count ? row : best),
    rows[0] ?? { day: '', count: 0 },
  );
  const max = Math.max(1, peak.count);
  return (
    <Card title={props.title} testId={props.testId}>
      {total === 0 ? (
        <p className="text-sm text-muted">{t('analytics.chart.empty')}</p>
      ) : (
        <>
          <div
            role="img"
            aria-label={t('analytics.chart.summary', {
              title: props.title,
              total: f.count(total),
              from: f.day(rows[0].day),
              to: f.day(rows[rows.length - 1].day),
              peakDay: f.day(peak.day),
              peak: f.count(peak.count),
            })}
            className="flex flex-col gap-1"
          >
            <span aria-hidden="true" className="text-xs text-muted">
              {f.count(peak.count)}
            </span>
            <div
              aria-hidden="true"
              className="flex h-32 items-end gap-0.5 border-b border-line"
            >
              {rows.map((row) => (
                <div
                  key={row.day}
                  className="group relative flex h-full min-w-0 flex-1 items-end"
                >
                  <div
                    className="w-full rounded-t bg-primary group-hover:bg-primary-hover"
                    style={{
                      height: row.count
                        ? `max(2px, ${(row.count / max) * 100}%)`
                        : 0,
                    }}
                  />
                  <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md bg-fg px-2 py-1 text-xs whitespace-nowrap text-canvas group-hover:block">
                    {f.day(row.day)}: {f.count(row.count)}
                  </span>
                </div>
              ))}
            </div>
            <div
              aria-hidden="true"
              className="flex justify-between text-xs text-muted"
            >
              <span>{f.day(rows[0].day)}</span>
              <span>{f.day(rows[rows.length - 1].day)}</span>
            </div>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">
              {t('analytics.table.show')}
            </summary>
            <table className="mt-2 w-full text-left tabular-nums">
              <thead>
                <tr className="text-muted">
                  <th className="py-1 font-medium">
                    {t('analytics.table.day')}
                  </th>
                  <th className="py-1 text-right font-medium">
                    {t('analytics.table.count')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.day} className="border-t border-line">
                    <td className="py-1">{f.day(row.day)}</td>
                    <td className="py-1 text-right">{f.count(row.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Card>
  );
}

/** A count with its share of the total, e.g. "12 · 40%". */
const share = (format: MetricFormat, count: number, total: number): string =>
  `${format.count(count)} · ${format.percent(count / total)}`;

/** Labelled rows with a share bar; the text carries every number. */
function Breakdown(props: {
  title: string;
  testId: string;
  rows: { label: string; count: number }[];
  f: MetricFormat;
}): ReactNode {
  const { t } = useI18n();
  const total = props.rows.reduce((sum, row) => sum + row.count, 0);
  const rows = [...props.rows].sort((a, b) => b.count - a.count);
  return (
    <Card title={props.title} testId={props.testId}>
      {total === 0 ? (
        <p className="text-sm text-muted">{t('analytics.chart.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <li key={row.label} className="flex min-w-0 flex-col gap-1 text-sm">
              <div className="flex min-w-0 justify-between gap-3">
                <span className="min-w-0 break-words">{row.label}</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {share(props.f, row.count, total)}
                </span>
              </div>
              <div
                aria-hidden="true"
                className="h-2 overflow-hidden rounded bg-surface-2"
              >
                <div
                  className="h-full rounded bg-primary"
                  style={{ width: `${(row.count / total) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Report(props: { data: AnalyticsReport; f: MetricFormat }): ReactNode {
  const { t } = useI18n();
  const { data, f: fmt } = props;
  const ofTotal = (part: number, total: number): string =>
    t('analytics.sub.ofTotal', {
      part: fmt.count(part),
      total: fmt.count(total),
    });
  const details: [string, string][] = [
    [t('analytics.details.crmFailed'), fmt.count(data.leads.crmFailed)],
    [t('analytics.details.crmPending'), fmt.count(data.leads.crmPending)],
    [t('analytics.details.slaAlerted'), fmt.count(data.handovers.slaAlerted)],
    [
      t('analytics.details.takeOver'),
      fmt.duration(data.handovers.takeOverP50Seconds),
    ],
    [
      t('analytics.details.toolErrors'),
      `${ofTotal(data.tools.errors, data.tools.calls)} · ${fmt.percent(data.tools.errorRate)}`,
    ],
    [
      t('analytics.details.guardrailHandovers'),
      fmt.count(data.guardrail.guardrailHandovers),
    ],
    [
      t('analytics.details.languageConfidence'),
      fmt.percent(data.languageDetection.averageConfidence),
    ],
    [
      t('analytics.details.lowConfidence'),
      ofTotal(
        data.languageDetection.lowConfidence,
        data.languageDetection.messages,
      ),
    ],
    [
      t('analytics.details.tokens'),
      `${fmt.count(data.cost.inputTokens)} / ${fmt.count(data.cost.outputTokens)}`,
    ],
  ];
  return (
    <>
      {data.conversations.total === 0 ? (
        <p
          role="status"
          data-testid="analytics-empty"
          className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm"
        >
          <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
          {t('analytics.empty')}
        </p>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          testId="analytics-conversations"
          label={t('analytics.tile.conversations')}
          value={fmt.count(data.conversations.total)}
        />
        <Tile
          testId="analytics-first-response"
          label={t('analytics.tile.firstResponse')}
          value={fmt.duration(data.firstResponse.p50Seconds)}
          sub={t('analytics.sub.p95', {
            value: fmt.duration(data.firstResponse.p95Seconds),
          })}
        />
        <Tile
          testId="analytics-auto-resolved"
          label={t('analytics.tile.autoResolved')}
          value={fmt.percent(data.resolution.autoResolvedRate)}
          sub={ofTotal(data.resolution.autoResolved, data.resolution.total)}
        />
        <Tile
          testId="analytics-handover"
          label={t('analytics.tile.handover')}
          value={fmt.percent(data.resolution.handoverRate)}
          sub={ofTotal(data.resolution.handedOver, data.resolution.total)}
        />
        <Tile
          testId="analytics-lead-capture"
          label={t('analytics.tile.leadCapture')}
          value={fmt.percent(data.leads.captureRate)}
          sub={t('analytics.sub.leads', { count: data.leads.total })}
        />
        <Tile
          testId="analytics-guardrail"
          label={t('analytics.tile.guardrail')}
          value={fmt.percent(data.guardrail.blockRate)}
          sub={ofTotal(data.guardrail.blockedTurns, data.guardrail.turns)}
        />
        <Tile
          testId="analytics-cost"
          label={t('analytics.tile.costPerConversation')}
          value={fmt.usd(data.cost.perConversationUsd)}
          sub={t('analytics.sub.totalCost', {
            value: fmt.usd(data.cost.totalUsd),
          })}
        />
        <Tile
          testId="analytics-latency"
          label={t('analytics.tile.latency')}
          value={fmt.milliseconds(data.latency.p50Ms)}
          sub={t('analytics.sub.p95', {
            value: fmt.milliseconds(data.latency.p95Ms),
          })}
        />
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <DailyBars
          testId="analytics-chart-conversations"
          title={t('analytics.chart.conversationsDaily')}
          rows={data.conversations.daily}
          f={fmt}
        />
        <DailyBars
          testId="analytics-chart-handovers"
          title={t('analytics.chart.handoversDaily')}
          rows={data.handovers.daily}
          f={fmt}
        />
        <Breakdown
          testId="analytics-chart-reasons"
          title={t('analytics.chart.handoverReasons')}
          rows={data.handovers.byReason.map((row) => ({
            label: reasonLabel(t, row.reason),
            count: row.count,
          }))}
          f={fmt}
        />
        <Breakdown
          testId="analytics-chart-languages"
          title={t('analytics.chart.languages')}
          rows={data.conversations.byLanguage.map((row) => ({
            label: row.language,
            count: row.count,
          }))}
          f={fmt}
        />
        <Breakdown
          testId="analytics-chart-scores"
          title={t('analytics.chart.leadScores')}
          rows={data.leads.byScore.map((row) => ({
            label: t(`score.${row.score}`),
            count: row.count,
          }))}
          f={fmt}
        />
        <Card title={t('analytics.details.title')} testId="analytics-details">
          <dl className="flex flex-col text-sm">
            {details.map(([label, value]) => (
              <div
                key={label}
                className="flex min-w-0 justify-between gap-3 border-t border-line py-2 first:border-t-0"
              >
                <dt className="min-w-0 break-words text-muted">{label}</dt>
                <dd className="shrink-0 text-right tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  );
}

/** Read-only Section 11 metrics for one tenant (12A.6, Phase 7.3). */
export function AnalyticsPage(): ReactNode {
  const { t, locale } = useI18n();
  const { operator } = useShell();
  const canManage = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [range, setRange] = useState<Range | null>(null);
  const [preset, setPreset] = useState<number | null>(30);
  // The tenant's "today", learnt from the first answer (days follow its time zone).
  const [today, setToday] = useState<string | null>(null);
  const fmt = useMemo(() => metricFormat(locale), [locale]);
  const query = useQuery({
    queryKey: ['analytics', range?.from ?? null, range?.to ?? null],
    queryFn: () =>
      api<AnalyticsReport>(
        `/api/v1/analytics${range ? `?from=${range.from}&to=${range.to}` : ''}`,
      ),
    enabled: canManage,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (!range && query.data) setToday(query.data.range.to);
  }, [range, query.data]);
  const shown = query.data?.range;

  function choose(days: number): void {
    if (!today) return;
    setPreset(days);
    setRange(presetRange(today, days));
  }
  function pick(edge: 'from' | 'to', value: string): void {
    if (!shown || !value) return;
    const next = { from: shown.from, to: shown.to, [edge]: value };
    if (next.from > next.to) return;
    setPreset(null);
    setRange(next);
  }

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.analytics')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('analytics.intro')}</p>
        {!canManage ? (
          <p
            role="status"
            data-testid="analytics-admin-only"
            className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm"
          >
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('analytics.adminOnly')}
          </p>
        ) : (
          <>
            <div
              role="group"
              aria-label={t('analytics.range.label')}
              className="flex min-w-0 flex-wrap items-end gap-3"
            >
              <div className="flex flex-wrap gap-2">
                {RANGE_PRESETS.map((days) => (
                  <Button
                    key={days}
                    size="sm"
                    variant={preset === days ? 'primary' : 'secondary'}
                    aria-pressed={preset === days}
                    disabled={!today}
                    onClick={() => choose(days)}
                    data-testid={`analytics-preset-${days}`}
                  >
                    {t('analytics.range.days', { days })}
                  </Button>
                ))}
              </div>
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t('analytics.range.from')}
                <input
                  type="date"
                  data-testid="analytics-from"
                  value={shown?.from ?? ''}
                  max={shown?.to}
                  onChange={(e) => pick('from', e.target.value)}
                  disabled={!shown}
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t('analytics.range.to')}
                <input
                  type="date"
                  data-testid="analytics-to"
                  value={shown?.to ?? ''}
                  min={shown?.from}
                  max={today ?? undefined}
                  onChange={(e) => pick('to', e.target.value)}
                  disabled={!shown}
                  className={fieldClass}
                />
              </label>
              {shown ? (
                <span className="text-xs text-muted">
                  {t('analytics.range.timezone', { timezone: shown.timezone })}
                </span>
              ) : null}
            </div>
            {query.isPending ? (
              <div
                role="status"
                className="overflow-hidden rounded-2xl border border-line bg-surface"
              >
                <span className="sr-only">{t('app.loading')}</span>
                <SkeletonRows rows={3} />
              </div>
            ) : null}
            {query.isError ? (
              <div className="flex flex-col items-start gap-3">
                <p
                  role="alert"
                  data-testid="analytics-error"
                  className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
                >
                  <Icon name="alert" />
                  {t(errorKey(query.error))}
                </p>
                <Button size="sm" onClick={() => void query.refetch()}>
                  {t('app.retry')}
                </Button>
              </div>
            ) : null}
            {query.data ? <Report data={query.data} f={fmt} /> : null}
          </>
        )}
      </div>
    </div>
  );
}
