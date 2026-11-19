'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { channelName } from '@/lib/channel-names';
import type { BoardStageView, LeadPipelineItem } from '@/lib/types';
import { useShell } from './app-shell';
import { ConversationViewPane } from './conversation-view';
import { LeadAiBlock } from './lead-ai-block';
import { LeadArchiveButton } from './lead-archive-button';
import { LeadMainInfo } from './lead-main-info';
import { LeadNotes } from './lead-notes';
import { LeadOpportunity } from './lead-opportunity';
import { LeadResponsible } from './lead-responsible';
import { LeadStageStepper } from './lead-stage-stepper';
import { LeadTagsEditor } from './lead-tags-fields';
import { LeadTasks } from './lead-tasks';
import { LeadTimeline } from './lead-timeline';
import { MoveToPipeline } from './move-to-pipeline';
import { useLeadStageMove } from './use-lead-stage-move';
import { Avatar } from './ui/avatar';
import { Icon } from './ui/icons';

type Tab = 'chat' | 'notes' | 'tasks' | 'history';
const TABS: Tab[] = ['chat', 'notes', 'tasks', 'history'];

/** One lead on its own page: the CRM card on the left, work on the right. */
export function LeadPage(props: { leadId: string }): ReactNode {
  const { t } = useI18n();
  const lead = useQuery({
    queryKey: ['leads', 'one', props.leadId],
    queryFn: () => api<LeadPipelineItem>(`/api/v1/leads/${props.leadId}`),
  });
  const pipelineId = lead.data?.pipelineId;
  const board = useQuery({
    queryKey: ['board', pipelineId, 'lead-page'],
    enabled: !!pipelineId,
    queryFn: () =>
      api<{ stages: BoardStageView[] }>(
        `/api/v1/pipelines/${pipelineId}/board`,
      ),
  });
  if (lead.isPending)
    return (
      <p role="status" className="p-6 text-sm text-muted">
        {t('app.loading')}
      </p>
    );
  if (lead.isError || !lead.data)
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p role="alert" data-testid="lead-page-error" className="text-sm">
          {t(errorKey(lead.error))}
        </p>
        <Link href="/leads" className="text-sm font-medium text-primary-fg">
          {t('leadPage.back')}
        </Link>
      </div>
    );
  return <LeadPageBody item={lead.data} stages={board.data?.stages ?? []} />;
}

function LeadPageBody(props: {
  item: LeadPipelineItem;
  stages: BoardStageView[];
}): ReactNode {
  const { t } = useI18n();
  const { operator, timeZone } = useShell();
  const { item, stages } = props;
  const manual = item.conversation.channelType === 'manual';
  const canEdit = ['OWNER', 'ADMIN', 'OPERATOR'].includes(operator.role);
  const canArchive = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const name = item.contact.name ?? t('list.unnamed');
  const [tab, setTab] = useState<Tab>(manual ? 'notes' : 'chat');
  const { requestMove, dialog } = useLeadStageMove(stages);
  const archived = !!item.archivedAt;
  const readOnly = !canEdit || archived;

  return (
    <div
      data-testid="lead-page"
      className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 p-3 sm:p-6"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-3">
        <Link
          href={`/leads?view=funnel&pipeline=${item.pipelineId}`}
          data-testid="lead-page-back"
          className="inline-flex min-h-9 items-center gap-1 rounded-lg text-sm font-medium text-primary-fg hover:underline"
        >
          <Icon name="chevronLeft" />
          {t('leadPage.back')}
        </Link>
        <Avatar name={name} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="min-w-0 break-words text-xl font-semibold">{name}</h1>
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 text-sm text-muted">
            <span>{channelName(item.conversation.channelType)}</span>
            {item.contact.phone ? (
              <span className="break-all">{item.contact.phone}</span>
            ) : null}
          </p>
        </div>
        {!manual ? (
          <Link
            href={`/inbox?scope=all&c=${item.conversation.id}`}
            data-testid="lead-panel-conversation"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg text-sm font-medium text-primary-fg hover:underline"
          >
            <Icon name="message" />
            {t('leads.openConversation')}
          </Link>
        ) : null}
      </header>
      {archived ? (
        <p
          role="status"
          data-testid="lead-page-archived"
          className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-fg"
        >
          {t('leadPage.archived')}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-col gap-4 lg:w-[26rem] lg:shrink-0">
          <LeadStageStepper
            item={item}
            stages={stages}
            canEdit={!readOnly}
            onRequestMove={requestMove}
          />
          {item.lostReason ? (
            <p
              data-testid="lead-panel-lost-reason"
              className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
            >
              {t('leads.lostBecause', { reason: item.lostReason })}
            </p>
          ) : null}
          <LeadResponsible item={item} />
          <LeadMainInfo
            leadId={item.id}
            fields={item.customFields ?? []}
            role={readOnly ? 'VIEWER' : operator.role}
          />
          <section
            aria-label={t('opportunity.title')}
            className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3 shadow-card"
          >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {t('opportunity.title')}
            </h2>
            <LeadOpportunity
              leadId={item.id}
              item={item}
              hideSummary
              hideOwner
              canEdit={!readOnly}
            />
          </section>
          <LeadTagsEditor
            leadId={item.id}
            tags={item.tags ?? []}
            role={readOnly ? 'VIEWER' : operator.role}
          />
          {!readOnly ? <LeadAiBlock item={item} stages={stages} /> : null}
          {!readOnly ? <MoveToPipeline leadId={item.id} /> : null}
          {canArchive && !archived ? (
            <LeadArchiveButton
              leadId={item.id}
              onArchived={() => {
                window.location.assign(
                  `/leads?view=funnel&pipeline=${item.pipelineId}`,
                );
              }}
            />
          ) : null}
        </div>
        <section
          aria-label={t('leadPage.work')}
          className="flex min-w-0 flex-1 flex-col gap-3"
        >
          <div
            role="tablist"
            aria-label={t('leadPage.work')}
            className="flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1"
          >
            {TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`lead-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`lead-tabpanel-${id}`}
                data-testid={`lead-tab-${id}`}
                onClick={() => setTab(id)}
                className={`min-h-9 shrink-0 rounded-lg px-4 text-sm font-medium ${
                  tab === id
                    ? 'bg-surface text-fg shadow-card'
                    : 'text-muted hover:text-fg'
                }`}
              >
                {t(`leadPage.tab.${id}`)}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`lead-tabpanel-${tab}`}
            aria-labelledby={`lead-tab-${tab}`}
            className="min-w-0"
          >
            {tab === 'chat' ? (
              manual ? (
                <p
                  data-testid="lead-chat-none"
                  className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted"
                >
                  {t('leadPage.noChat')}
                </p>
              ) : (
                <div className="flex h-[70dvh] min-h-96 overflow-hidden rounded-xl border border-line">
                  <ConversationViewPane
                    id={item.conversation.id}
                    me={{ id: operator.id, role: operator.role }}
                    timeZone={timeZone}
                    onBack={() => undefined}
                    embedded
                  />
                </div>
              )
            ) : null}
            {tab === 'notes' ? <LeadNotes leadId={item.id} /> : null}
            {tab === 'tasks' ? <LeadTasks leadId={item.id} /> : null}
            {tab === 'history' ? <LeadTimeline leadId={item.id} flat /> : null}
          </div>
        </section>
      </div>
      {dialog}
    </div>
  );
}
