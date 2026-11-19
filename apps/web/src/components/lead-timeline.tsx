'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { timelineLine, type TimelineEntry } from '@/lib/lead-timeline';
import { useShell } from './app-shell';
import { Icon, type IconName } from './ui/icons';
import { Section } from './ui/section';

const ICON: Record<TimelineEntry['kind'], IconName> = {
  'lead.created': 'target',
  'stage.moved': 'chart',
  'lead.updated': 'pencil',
  'lead.archived': 'trash',
  'task.created': 'clock',
  'task.done': 'check',
  note: 'note',
  'handover.opened': 'headset',
  'handover.taken': 'user',
  'handover.resolved': 'check',
  message: 'message',
};

/**
 * What happened on a lead, newest first (roadmap P1.7, ADR 069): messages,
 * stage changes, tasks, notes and handovers in one list. Text is shown as
 * plain text; customer words are never rendered as markup.
 */
export function LeadTimeline(props: {
  leadId: string;
  /** A tab body: always open, no accordion. */
  flat?: boolean;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { timeZone } = useShell();
  const list = useQuery({
    queryKey: ['lead-timeline', props.leadId],
    queryFn: () =>
      api<{ items: TimelineEntry[] }>(`/api/v1/leads/${props.leadId}/timeline`),
  });
  const items = list.data?.items ?? [];
  return (
    <Section
      title={t('timeline.title')}
      icon="clock"
      testId="lead-timeline"
      level={props.flat ? 2 : 3}
      collapsible={!props.flat}
      defaultOpen={props.flat ? true : false}
      storageKey={props.flat ? undefined : 'lead-timeline'}
      summary={t('timeline.summary', { count: items.length })}
    >
      {list.isError ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t('timeline.failed')}
        </p>
      ) : items.length === 0 && !list.isPending ? (
        <p className="text-sm text-muted">{t('timeline.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((entry) => (
            <li
              key={entry.id}
              data-testid="timeline-entry"
              data-kind={entry.kind}
              className="flex items-start gap-2 text-sm"
            >
              <span className="mt-0.5 shrink-0 text-muted" aria-hidden>
                <Icon name={ICON[entry.kind]} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="block">{timelineLine(t, entry)}</span>
                <span className="block text-xs text-muted">
                  {formatDateTime(entry.at, timeZone)}
                  {entry.actorName
                    ? ` · ${t('timeline.by', { name: entry.actorName })}`
                    : ''}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
