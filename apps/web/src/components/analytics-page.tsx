'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import {
  durationParts,
  formatCount,
  formatDay,
  formatPercent,
  formatUsd,
  millisToSeconds,
  shiftDay,
  todayIn,
} from '@/lib/analytics-format';
import { api, errorKey } from '@/lib/api';
import type { AnalyticsReport } from '@/lib/types';
import { useShell } from './app-shell';
import { Button } from './ui/button';
import { BarList, ChartCard, ColumnChart, type Point } from './ui/charts';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

const PRESETS = [7, 30, 90] as const;

function Kpi(props: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface p-4 shadow-card"
    >
      <span className="text-sm text-muted">{props.label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">
        {props.value}
      </span>
      {props.hint ? (
        <span className="text-xs break-words text-muted">{props.hint}</span>
      ) : null}
    </div>
  );
}

function Row(props: {
  label: string;
  value: string;
  hint?: string;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-t border-line py-2.5 first:border-t-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="min-w-0 text-sm">{props.label}</dt>
      <dd className="flex min-w-0 flex-col sm:items-end">
        <span className="font-medium tabular-nums">{props.value}</span>
        {props.hint ? (
          <span className="text-xs break-words text-muted">{props.hint}</span>
        ) : null}
      </dd>
    </div>
  );
}

/** Read-only metrics (Section 11) for a chosen period, for owners and admins. */
export function AnalyticsPage(): ReactNode {
  const { t, locale } = useI18n();
  const { operator, timeZone } = useShell();
  const allowed = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const today = useMemo(() => todayIn(timeZone), [timeZone]);
  const [preset, setPreset] = useState<number | 'custom'>(30);
  const [from, setFrom] = useState(shiftDay(today, 29));
  const [to, setTo] = useState(today);
  const [applied, setApplied] = useState({
    from: shiftDay(today, 29),
    to: today,
  });

  const query = useQuery({
    queryKey: ['analytics', applied.from, applied.to],
    queryFn: () =>
      api<AnalyticsReport>(
        `/api/v1/analytics?from=${applied.from}&to=${applied.to}`,
      ),
    enabled: allowed,
  });

  function choose(days: number): void {
    const range = { from: shiftDay(today, days - 1), to: today };
    setPreset(days);
    setFrom(range.from);
    setTo(range.to);
    setApplied(range);
  }

  const report = query.data;
  const duration = (seconds: number | null): string => {
    const parts = durationParts(locale, seconds);
    return parts ? `${parts.value} ${t(`analytics.unit.${parts.unit}`)}` : '—';
  };
  const count = (n: number): string => formatCount(locale, n);
  const dailyPoints = (rows: { day: string; count: number }[]): Point[] =>
    rows.map((row) => ({
      label: formatDay(locale, row.day),
      value: row.count,
      title: `${formatDay(locale, row.day)}: ${count(row.count)}`,
    }));
  const summary = (
    rows: { day: string; count: number }[],
  ): string | undefined => {
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    if (total === 0) return undefined;
    const peak = rows.reduce((best, row) =>
      row.count > best.count ? row : best,
    );
    return t('analytics.chart.summary', {
      total: count(total),
      peakDay: formatDay(locale, peak.day),
      peak: count(peak.count),
    });
  };

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.analytics')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('analytics.intro')}</p>
        {!allowed ? (
          <p
            data-testid="analytics-no-access"
            className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm text-muted"
          >
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('analytics.noAccess')}
          </p>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-end gap-3">
              <div
                role="radiogroup"
                aria-label={t('analytics.range')}
                className="flex gap-1 rounded-xl bg-surface-2 p-1"
              >
                {PRESETS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    role="radio"
                    aria-checked={preset === days}
                    data-testid={`analytics-preset-${days}`}
                    onClick={() => choose(days)}
                    className={`min-h-9 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors ${
                      preset === days
                        ? 'bg-surface text-fg shadow-card'
                        : 'text-muted hover:text-fg'
                    }`}
                  >
                    {t(`analytics.last${days}`)}
                  </button>
                ))}
              </div>
              <form
                className="flex min-w-0 flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (from && to && from <= to) {
                    setPreset('custom');
                    setApplied({ from, to });
                  }
                }}
              >
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
                  {t('analytics.from')}
                  <input
                    type="date"
                    data-testid="analytics-from"
                    value={from}
                    max={to}
                    onChange={(e) => setFrom(e.target.value)}
                    className={`${fieldClass} min-h-10 w-40 text-sm text-fg`}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
                  {t('analytics.to')}
                  <input
                    type="date"
                    data-testid="analytics-to"
                    value={to}
                    min={from}
                    max={today}
                    onChange={(e) => setTo(e.target.value)}
                    className={`${fieldClass} min-h-10 w-40 text-sm text-fg`}
                  />
                </label>
                <Button type="submit" data-testid="analytics-apply">
                  {t('analytics.apply')}
                </Button>
              </form>
            </div>

            {query.isPending ? (
              <div
                role="status"
                className="overflow-hidden rounded-2xl border border-line bg-surface"
              >
                <span className="sr-only">{t('app.loading')}</span>
                <SkeletonRows rows={4} />
              </div>
            ) : null}
            {query.isError ? (
              <div className="flex flex-col items-start gap-3">
                <p
                  role="alert"
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

            {report ? (
              <>
                {report.conversations.total === 0 ? (
                  <p
                    data-testid="analytics-empty"
                    className="rounded-2xl border border-dashed border-line bg-surface p-4 text-center text-sm text-muted"
                  >
                    {t('analytics.empty')}
                  </p>
                ) : null}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Kpi
                    testId="kpi-conversations"
                    label={t('analytics.kpi.conversations')}
                    value={count(report.conversations.total)}
                  />
                  <Kpi
                    testId="kpi-auto"
                    label={t('analytics.kpi.autoResolved')}
                    value={formatPercent(
                      locale,
                      report.resolution.autoResolvedRate,
                    )}
                    hint={t('analytics.kpiHint.autoResolved', {
                      count: report.resolution.autoResolved,
                    })}
                  />
                  <Kpi
                    testId="kpi-handover"
                    label={t('analytics.kpi.handoverRate')}
                    value={formatPercent(
                      locale,
                      report.resolution.handoverRate,
                    )}
                    hint={t('analytics.kpiHint.handoverRate', {
                      count: report.resolution.handedOver,
                    })}
                  />
                  <Kpi
                    testId="kpi-first-response"
                    label={t('analytics.kpi.firstResponse')}
                    value={duration(report.firstResponse.p50Seconds)}
                    hint={
                      report.firstResponse.p95Seconds === null
                        ? undefined
                        : t('analytics.kpiHint.firstResponse', {
                            value: durationParts(
                              locale,
                              report.firstResponse.p95Seconds,
                            )!.value,
                            unit: t(
                              `analytics.unit.${durationParts(locale, report.firstResponse.p95Seconds)!.unit}`,
                            ),
                          })
                    }
                  />
                  <Kpi
                    testId="kpi-leads"
                    label={t('analytics.kpi.leads')}
                    value={count(report.leads.total)}
                    hint={t('analytics.kpiHint.leads', {
                      rate: formatPercent(locale, report.leads.captureRate),
                    })}
                  />
                  <Kpi
                    testId="kpi-cost"
                    label={t('analytics.kpi.costPerConversation')}
                    value={formatUsd(locale, report.cost.perConversationUsd)}
                    hint={t('analytics.kpiHint.cost', {
                      total: formatUsd(locale, report.cost.totalUsd),
                    })}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <ChartCard
                    title={t('analytics.chart.conversations')}
                    summary={summary(report.conversations.daily)}
                    tableHead={[
                      t('analytics.chart.day'),
                      t('analytics.chart.count'),
                    ]}
                    rows={dailyPoints(report.conversations.daily)}
                  >
                    <ColumnChart
                      ariaLabel={t('analytics.chart.conversations')}
                      points={dailyPoints(report.conversations.daily)}
                    />
                  </ChartCard>
                  <ChartCard
                    title={t('analytics.chart.handovers')}
                    summary={summary(report.handovers.daily)}
                    tableHead={[
                      t('analytics.chart.day'),
                      t('analytics.chart.count'),
                    ]}
                    rows={dailyPoints(report.handovers.daily)}
                  >
                    <ColumnChart
                      ariaLabel={t('analytics.chart.handovers')}
                      points={dailyPoints(report.handovers.daily)}
                    />
                  </ChartCard>
                  <ChartCard
                    title={t('analytics.chart.handoverReasons')}
                    tableHead={[
                      t('analytics.chart.handoverReasons'),
                      t('analytics.chart.count'),
                    ]}
                    rows={report.handovers.byReason.map((row) => ({
                      label: t(`analytics.reason.${row.reason}`),
                      value: row.count,
                      title: `${t(`analytics.reason.${row.reason}`)}: ${count(row.count)}`,
                    }))}
                  >
                    <BarList
                      empty={t('analytics.chart.noData')}
                      rows={report.handovers.byReason.map((row) => ({
                        label: t(`analytics.reason.${row.reason}`),
                        value: row.count,
                        title: `${t(`analytics.reason.${row.reason}`)}: ${count(row.count)}`,
                      }))}
                    />
                  </ChartCard>
                  <ChartCard
                    title={t('analytics.chart.languages')}
                    tableHead={[
                      t('analytics.chart.languages'),
                      t('analytics.chart.count'),
                    ]}
                    rows={report.conversations.byLanguage.map((row) => ({
                      label: languageLabel(row.language, t),
                      value: row.count,
                      title: `${languageLabel(row.language, t)}: ${count(row.count)}`,
                    }))}
                  >
                    <BarList
                      empty={t('analytics.chart.noData')}
                      rows={report.conversations.byLanguage.map((row) => ({
                        label: languageLabel(row.language, t),
                        value: row.count,
                        title: `${languageLabel(row.language, t)}: ${count(row.count)}`,
                      }))}
                    />
                  </ChartCard>
                  <ChartCard
                    title={t('analytics.chart.leadScores')}
                    tableHead={[
                      t('analytics.chart.leadScores'),
                      t('analytics.chart.count'),
                    ]}
                    rows={report.leads.byScore.map((row) => ({
                      label: t(`score.${row.score}`),
                      value: row.count,
                      title: `${t(`score.${row.score}`)}: ${count(row.count)}`,
                    }))}
                  >
                    <BarList
                      empty={t('analytics.chart.noData')}
                      rows={report.leads.byScore.map((row) => ({
                        label: t(`score.${row.score}`),
                        value: row.count,
                        title: `${t(`score.${row.score}`)}: ${count(row.count)}`,
                      }))}
                    />
                  </ChartCard>
                </div>

                <section
                  aria-labelledby="analytics-quality"
                  className="rounded-2xl border border-line bg-surface p-4 shadow-card"
                >
                  <h2 id="analytics-quality" className="mb-1 font-semibold">
                    {t('analytics.quality')}
                  </h2>
                  <dl data-testid="analytics-quality">
                    <Row
                      label={t('analytics.q.guardrail')}
                      value={formatPercent(locale, report.guardrail.blockRate)}
                      hint={t('analytics.q.guardrailHint', {
                        blocked: report.guardrail.blockedTurns,
                        turns: report.guardrail.turns,
                        handovers: report.guardrail.guardrailHandovers,
                      })}
                    />
                    <Row
                      label={t('analytics.q.tools')}
                      value={formatPercent(locale, report.tools.errorRate)}
                      hint={t('analytics.q.toolsHint', {
                        errors: report.tools.errors,
                        calls: report.tools.calls,
                      })}
                    />
                    <Row
                      label={t('analytics.q.latency')}
                      value={`${duration(millisToSeconds(report.latency.p50Ms))} / ${duration(millisToSeconds(report.latency.p95Ms))}`}
                    />
                    <Row
                      label={t('analytics.q.takeOver')}
                      value={duration(report.handovers.takeOverP50Seconds)}
                    />
                    <Row
                      label={t('analytics.q.sla')}
                      value={count(report.handovers.slaAlerted)}
                    />
                    <Row
                      label={t('analytics.q.crm')}
                      value={count(report.leads.crmFailed)}
                      hint={t('analytics.q.crmHint', {
                        pending: report.leads.crmPending,
                      })}
                    />
                    <Row
                      label={t('analytics.q.detection')}
                      value={formatPercent(
                        locale,
                        report.languageDetection.averageConfidence,
                      )}
                      hint={t('analytics.q.detectionHint', {
                        low: report.languageDetection.lowConfidence,
                        messages: report.languageDetection.messages,
                      })}
                    />
                    <Row
                      label={t('analytics.q.tokens')}
                      value={count(
                        report.cost.inputTokens + report.cost.outputTokens,
                      )}
                      hint={t('analytics.q.tokensHint', {
                        input: count(report.cost.inputTokens),
                        output: count(report.cost.outputTokens),
                      })}
                    />
                  </dl>
                </section>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Language ids are codes ("uz"); the unknown bucket is translated. */
function languageLabel(language: string, t: (key: string) => string): string {
  return language === 'unknown' ? t('analytics.language.unknown') : language;
}
