'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import {
  assistantLight,
  greetingPart,
  hourIn,
  setupItems,
  type AssistantLight,
  type SetupKey,
  type TodaySummary,
} from '@/lib/today';
import type { ChannelAccount } from '@/lib/types';
import { useShell } from './app-shell';
import { Badge, type Tone } from './ui/badge';
import { buttonClass } from './ui/button';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

const LIGHT_TONE: Record<AssistantLight, Tone> = {
  live: 'success',
  drafts: 'warning',
  hold: 'warning',
  off: 'neutral',
  none: 'danger',
};
const LIGHT_DOT: Record<AssistantLight, string> = {
  live: 'bg-success-fg',
  drafts: 'bg-warning-fg',
  hold: 'bg-warning-fg',
  off: 'bg-muted',
  none: 'bg-danger-fg',
};

/**
 * The home page (UX review A4): what needs a person right now, how the
 * assistant is doing, and what a new workspace still has to set up. Counts
 * come from one small API call; nothing here shows customer text.
 */
export function TodayPage(): ReactNode {
  const { t } = useI18n();
  const { operator, timeZone } = useShell();
  const manager = operator.role === 'OWNER' || operator.role === 'ADMIN';

  const summary = useQuery({
    queryKey: ['today'],
    queryFn: () => api<TodaySummary>('/api/v1/today'),
    refetchInterval: 30_000,
  });
  const channels = useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ items: ChannelAccount[] }>('/api/v1/channels'),
  });

  const light: AssistantLight | null = channels.data
    ? assistantLight(channels.data.items)
    : null;
  const today = summary.data;
  const name = operator.displayName.split(' ')[0] ?? operator.displayName;
  const part = greetingPart(hourIn(new Date(), timeZone));
  const waiting = today?.waiting.total ?? 0;

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.today')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
        <section className="rounded-3xl bg-primary-soft p-5 sm:p-7">
          <h2 className="text-2xl font-semibold text-primary-fg">
            {t(`today.greeting.${part}`, { name })}
          </h2>
          <p className="mt-1 text-base text-fg" data-testid="today-lead">
            {summary.isPending
              ? ' '
              : waiting > 0
                ? t('today.lead.waiting', { count: waiting })
                : t('today.lead.clear')}
          </p>
        </section>

        {summary.isError ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(summary.error))}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile
            testId="today-waiting"
            label={t('today.tile.waiting')}
            value={today?.waiting.total}
            tone={waiting > 0 ? 'accent' : 'neutral'}
            href="/inbox"
            action={t('today.action.openInbox')}
          />
          <Tile
            testId="today-overdue"
            label={t('today.tile.overdue')}
            value={today?.waiting.overdue}
            tone={(today?.waiting.overdue ?? 0) > 0 ? 'danger' : 'neutral'}
            href="/inbox"
            action={t('today.action.openInbox')}
          />
          <Tile
            testId="today-leads"
            label={t('today.tile.newLeads')}
            value={today?.newLeads}
            tone="neutral"
            href="/leads"
            action={t('today.action.openLeads')}
          />
        </div>

        {light ? (
          <AssistantCard light={light} manager={manager} />
        ) : channels.isPending ? (
          <SkeletonRows rows={1} />
        ) : null}

        {today?.checklist && light ? (
          <SetupCard checklist={today.checklist} light={light} />
        ) : null}
      </div>
    </div>
  );
}

function Tile(props: {
  testId: string;
  label: string;
  value: number | undefined;
  tone: Tone;
  href: string;
  action: string;
}): ReactNode {
  const hot = props.tone === 'danger' || props.tone === 'accent';
  return (
    <Link
      href={props.href}
      data-testid={props.testId}
      className={`group flex flex-col gap-1 rounded-2xl border p-4 transition-colors hover:bg-surface-2 ${
        props.tone === 'danger'
          ? 'border-danger-fg/40 bg-danger-soft'
          : 'border-line bg-surface'
      }`}
    >
      <span className="text-sm text-muted">{props.label}</span>
      <span
        className={`text-4xl font-semibold tabular-nums ${
          hot
            ? props.tone === 'danger'
              ? 'text-danger-fg'
              : 'text-primary-fg'
            : 'text-fg'
        }`}
        data-testid={`${props.testId}-value`}
      >
        {props.value ?? '–'}
      </span>
      <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-primary-fg group-hover:underline">
        {props.action}
        <Icon name="chevronRight" className="h-4 w-4" />
      </span>
    </Link>
  );
}

function AssistantCard(props: {
  light: AssistantLight;
  manager: boolean;
}): ReactNode {
  const { t } = useI18n();
  const { light } = props;
  return (
    <section
      data-testid="today-assistant"
      data-light={light}
      aria-label={t('today.assistant.title')}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${LIGHT_DOT[light]} ${
            light === 'live' ? 'motion-safe:animate-pulse' : ''
          }`}
        />
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {t('today.assistant.title')}
            <Badge tone={LIGHT_TONE[light]}>
              {t(`today.assistant.${light}`)}
            </Badge>
          </p>
          <p className="text-sm text-muted">
            {t(`today.assistant.${light}.hint`)}
          </p>
        </div>
      </div>
      {props.manager ? (
        <Link
          href={light === 'none' ? '/settings/channels' : '/settings/bot'}
          className={`${buttonClass('secondary')} shrink-0`}
        >
          {light === 'none'
            ? t('today.assistant.connect')
            : t('today.assistant.manage')}
        </Link>
      ) : null}
    </section>
  );
}

function SetupCard(props: {
  checklist: NonNullable<TodaySummary['checklist']>;
  light: AssistantLight;
}): ReactNode {
  const { t } = useI18n();
  const items = setupItems(props.checklist, props.light);
  const done = items.filter((item) => item.done).length;
  const percent = Math.round((done / items.length) * 100);
  return (
    <section
      data-testid="today-setup"
      aria-label={t('today.setup.title')}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t('today.setup.title')}</h3>
        <span className="text-sm text-muted" data-testid="today-setup-progress">
          {t('today.setup.progress', { done, total: items.length })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t('today.setup.title')}
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={done}
        className="h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      {done === items.length ? (
        <p className="text-sm text-success-fg">{t('today.setup.allDone')}</p>
      ) : null}
      <ul className="flex flex-col divide-y divide-line">
        {items.map((item) => (
          <li
            key={item.key}
            data-testid={`today-step-${item.key}`}
            data-done={item.done}
            className="flex items-center gap-3 py-3"
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                item.done
                  ? 'bg-success-soft text-success-fg'
                  : 'border border-line text-transparent'
              }`}
            >
              <Icon name="check" className="h-3.5 w-3.5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className={
                  item.done ? 'text-muted line-through' : 'font-medium'
                }
              >
                {t(`today.setup.${item.key satisfies SetupKey}`)}
              </span>
              <span className="text-sm text-muted">
                {t(`today.setup.${item.key}.hint`)}
              </span>
            </span>
            {item.done ? (
              <span className="text-sm text-success-fg">
                {t('today.setup.done')}
              </span>
            ) : (
              <Link
                href={item.href}
                className={`${buttonClass('secondary', 'sm')} shrink-0`}
              >
                {t('today.setup.go')}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
