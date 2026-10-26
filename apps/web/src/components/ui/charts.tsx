'use client';

import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { formatCount } from '@/lib/analytics-format';
import { Button } from './button';

/**
 * Small accessible charts drawn as SVG with attributes only (the page's CSP
 * refuses inline style attributes). One series, one hue; bars are at most 24
 * units thick with a 4-unit rounded data end and a square base; the value sits
 * at the tip or on the axis; text uses text tokens, never the data colour; a
 * table view carries every value for anyone who cannot read the picture.
 */

export interface Point {
  label: string;
  value: number;
  /** Tooltip / table text, e.g. "Mar 1: 12". */
  title: string;
}

const W = 600;
const H = 150;
const LEFT = 34;
const TOP = 8;
const BOTTOM = 22;

/** A bar with a rounded data end and a square base. */
function Bar(props: {
  x: number;
  y: number;
  width: number;
  height: number;
}): ReactNode {
  const { x, y, width, height } = props;
  const r = Math.min(4, width / 2, height);
  if (r < 1)
    return (
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        className="fill-primary"
      />
    );
  const d = `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
  return <path d={d} className="fill-primary" />;
}

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * magnitude >= value) ?? 10;
  return step * magnitude;
}

export function ChartCard(props: {
  title: string;
  summary?: string;
  tableHead: [string, string];
  rows: Point[];
  children: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  const [table, setTable] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-semibold">{props.title}</h2>
          {props.summary ? (
            <p className="text-xs text-muted">{props.summary}</p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={table}
          onClick={() => setTable(!table)}
        >
          {table ? t('analytics.chart.graph') : t('analytics.chart.table')}
        </Button>
      </header>
      {table ? (
        <div
          role="region"
          tabIndex={0}
          aria-label={props.title}
          className="max-h-64 overflow-y-auto"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {props.tableHead[0]}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {props.tableHead[1]}
                </th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <tr key={row.label} className="border-t border-line">
                  <th
                    scope="row"
                    className="py-1 pr-3 text-left font-normal break-words"
                  >
                    {row.label}
                  </th>
                  <td className="py-1 text-right tabular-nums">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        props.children
      )}
    </section>
  );
}

/** Columns over a calendar axis (one per day). */
export function ColumnChart(props: {
  points: Point[];
  ariaLabel: string;
}): ReactNode {
  const { locale } = useI18n();
  const { points } = props;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const plotW = W - LEFT - 4;
  const plotH = H - TOP - BOTTOM;
  const slot = plotW / Math.max(points.length, 1);
  const width = Math.max(1, Math.min(24, slot - 2));
  const ticks = [0, max / 2, max];
  const xLabels = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={props.ariaLabel}
      className="h-auto w-full"
    >
      {ticks.map((tick) => {
        const y = TOP + plotH - (tick / max) * plotH;
        return (
          <g key={tick}>
            <line
              x1={LEFT}
              x2={W - 4}
              y1={y}
              y2={y}
              className="stroke-line"
              strokeWidth="1"
            />
            <text
              x={LEFT - 6}
              y={y + 4}
              textAnchor="end"
              fontSize="11"
              className="fill-muted"
            >
              {formatCount(locale, tick)}
            </text>
          </g>
        );
      })}
      {points.map((point, index) => {
        const h = (point.value / max) * plotH;
        const x = LEFT + index * slot + (slot - width) / 2;
        return (
          <g key={point.label}>
            <title>{point.title}</title>
            {point.value > 0 ? (
              <Bar x={x} y={TOP + plotH - h} width={width} height={h} />
            ) : null}
            <rect
              x={LEFT + index * slot}
              y={TOP}
              width={slot}
              height={plotH}
              fill="transparent"
            />
          </g>
        );
      })}
      {[...new Set(xLabels)]
        .filter((i) => i >= 0)
        .map((i, order, all) => (
          <text
            key={i}
            x={LEFT + i * slot + slot / 2}
            y={H - 6}
            textAnchor={
              order === 0
                ? 'start'
                : order === all.length - 1
                  ? 'end'
                  : 'middle'
            }
            fontSize="11"
            className="fill-muted"
          >
            {points[i].label}
          </text>
        ))}
    </svg>
  );
}

/** Horizontal bars with the value at the tip, largest first. */
export function BarList(props: { rows: Point[]; empty: string }): ReactNode {
  const { locale } = useI18n();
  if (props.rows.length === 0)
    return <p className="py-6 text-center text-sm text-muted">{props.empty}</p>;
  const max = Math.max(1, ...props.rows.map((row) => row.value));
  return (
    <ul className="flex flex-col gap-2.5">
      {props.rows.map((row) => (
        <li
          key={row.label}
          className="flex min-w-0 flex-col gap-1"
          title={row.title}
        >
          <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 break-words">{row.label}</span>
            <span className="shrink-0 tabular-nums">
              {formatCount(locale, row.value)}
            </span>
          </div>
          <svg
            viewBox="0 0 100 6"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="h-1.5 w-full"
          >
            <rect width="100" height="6" rx="3" className="fill-surface-2" />
            <rect
              width={Math.max(row.value > 0 ? 2 : 0, (row.value / max) * 100)}
              height="6"
              rx="3"
              className="fill-primary"
            />
          </svg>
        </li>
      ))}
    </ul>
  );
}
