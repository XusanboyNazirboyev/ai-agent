'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { channelName } from '@/lib/channel-names';
import type { BoardStageView, LeadPipelineItem } from '@/lib/types';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';
import { currentStageId, stageLabel } from './lead-board-utils';
import { LeadOpportunity } from './lead-opportunity';
import { LeadCustomFieldsEditor, LeadTagsEditor } from './lead-tags-fields';
import { MoveToPipeline } from './move-to-pipeline';

const STEP_BASE =
  'min-h-9 min-w-0 max-w-full rounded-lg border px-2.5 text-xs font-medium transition-colors';

function stepClass(
  kind: BoardStageView['kind'],
  state: 'current' | 'passed' | 'ahead',
): string {
  if (kind === 'WON')
    return state === 'current'
      ? 'border-success-fg bg-success-soft text-success-fg ring-2 ring-success-fg'
      : 'border-line bg-surface text-success-fg hover:bg-success-soft';
  if (kind === 'LOST')
    return state === 'current'
      ? 'border-danger bg-danger-soft text-danger-fg ring-2 ring-danger'
      : 'border-line bg-surface text-danger-fg hover:bg-danger-soft';
  if (state === 'current')
    return 'border-primary bg-primary text-white ring-2 ring-primary';
  if (state === 'passed')
    return 'border-primary-soft bg-primary-soft text-primary-fg hover:border-primary';
  return 'border-line bg-surface text-muted hover:bg-surface-2 hover:text-fg';
}

/**
 * The lead detail side sheet (sheet on md+, full screen below): the board is
 * for scanning and moving, this is for editing. A modal dialog, so focus is
 * trapped, Escape closes and focus returns to the card.
 */
export function LeadPanel(props: {
  item: LeadPipelineItem | null;
  stages: BoardStageView[];
  /** Focus goes back here when the panel closes (or to the lead's card). */
  opener: HTMLElement | null;
  onClose: () => void;
  onRequestMove: (item: LeadPipelineItem, toStageId: string) => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const open = props.item !== null;
  const leadId = props.item?.id ?? null;
  const openerRef = useRef<HTMLElement | null>(null);
  openerRef.current = props.opener;

  const lastLeadId = useRef<string | null>(null);
  if (leadId) lastLeadId.current = leadId;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) {
      dialog.close();
      // Focus goes back to the lead's open button (its column may have changed).
      const id = lastLeadId.current;
      const card = id
        ? document.querySelector<HTMLElement>(
            `[data-lead-open="${CSS.escape(id)}"]`,
          )
        : null;
      const target = card ?? openerRef.current;
      if (target?.isConnected) target.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="lead-panel"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onClose();
      }}
      className="fixed inset-0 m-0 ml-auto h-dvh max-h-none w-full max-w-none overflow-hidden border-l border-line bg-surface p-0 text-fg shadow-pop md:w-[28rem]"
    >
      {props.item ? (
        <PanelBody
          item={props.item}
          stages={props.stages}
          titleId={titleId}
          onClose={props.onClose}
          onRequestMove={props.onRequestMove}
        />
      ) : null}
    </dialog>
  );
}

function PanelBody(props: {
  item: LeadPipelineItem;
  stages: BoardStageView[];
  titleId: string;
  onClose: () => void;
  onRequestMove: (item: LeadPipelineItem, toStageId: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const { item, stages } = props;
  const canEdit = ['OWNER', 'ADMIN', 'OPERATOR'].includes(operator.role);
  const name = item.contact.name ?? t('list.unnamed');
  const stageId = currentStageId(item, stages);
  const currentIndex = stages.findIndex((s) => s.id === stageId);
  const stageHeadingId = useId();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b border-line p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={name} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2
              id={props.titleId}
              className="min-w-0 break-words text-lg font-semibold"
            >
              {name}
            </h2>
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted">
              <span>{channelName(item.conversation.channelType)}</span>
              {item.contact.phone ? (
                <span className="min-w-0 break-all">{item.contact.phone}</span>
              ) : null}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon="x"
            data-testid="lead-panel-close"
            aria-label={t('leads.panelClose')}
            onClick={props.onClose}
          />
        </div>
        <Link
          href={`/inbox?scope=all&c=${item.conversation.id}`}
          data-testid="lead-panel-conversation"
          className="inline-flex min-h-9 w-fit items-center gap-1.5 rounded-lg text-sm font-medium text-primary-fg hover:underline"
        >
          <Icon name="message" />
          {t('leads.openConversation')}
        </Link>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <nav aria-labelledby={stageHeadingId} className="flex flex-col gap-2">
          <h3
            id={stageHeadingId}
            className="text-xs font-semibold uppercase tracking-wide text-muted"
          >
            {t('leads.stageProgress')}
          </h3>
          <ol
            data-testid="lead-panel-stages"
            className="flex min-w-0 flex-wrap gap-1.5"
          >
            {stages.map((stage, index) => {
              const state =
                stage.id === stageId
                  ? 'current'
                  : index < currentIndex
                    ? 'passed'
                    : 'ahead';
              return (
                <li key={stage.id} className="flex min-w-0 max-w-full">
                  <button
                    type="button"
                    data-testid={`lead-panel-stage-${stage.code ?? stage.id}`}
                    aria-current={state === 'current' ? 'step' : undefined}
                    disabled={!canEdit}
                    onClick={() => {
                      if (state !== 'current')
                        props.onRequestMove(item, stage.id);
                    }}
                    className={`${STEP_BASE} ${stepClass(stage.kind, state)} disabled:cursor-default`}
                  >
                    <span className="block truncate">
                      {stageLabel(stage, t)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        {canEdit ? <AiBlock item={item} stages={stages} /> : null}
        {item.lostReason ? (
          <p
            data-testid="lead-panel-lost-reason"
            className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            {t('leads.lostBecause', { reason: item.lostReason })}
          </p>
        ) : null}
        <section
          aria-label={t('opportunity.title')}
          className="flex flex-col gap-2"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t('opportunity.title')}
          </h3>
          <LeadOpportunity leadId={item.id} item={item} hideSummary />
        </section>
        {canEdit ? <MoveToPipeline leadId={item.id} /> : null}
        <LeadTagsEditor
          leadId={item.id}
          tags={item.tags ?? []}
          role={operator.role}
        />
        <LeadCustomFieldsEditor
          leadId={item.id}
          fields={item.customFields ?? []}
          role={operator.role}
        />
      </div>
    </div>
  );
}

/** Who staged the lead; the AI suggestion; handing the lead back (ADR 058). */
function AiBlock(props: {
  item: LeadPipelineItem;
  stages: BoardStageView[];
}): ReactNode {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const { item, stages } = props;
  const stageId = currentStageId(item, stages);
  const suggested =
    item.suggestedStageId && item.suggestedStageId !== stageId
      ? stages.find((s) => s.id === item.suggestedStageId)
      : undefined;

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['leads'] });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };
  const post = (action: string) =>
    api(`/api/v1/leads/${item.id}/${action}`, { method: 'POST' });
  const accept = useMutation({
    mutationFn: () => post('stage-suggestion/accept'),
    onSettled: refresh,
    onError: (e) => toast(t(errorKey(e))),
  });
  const dismiss = useMutation({
    mutationFn: () => post('stage-suggestion/dismiss'),
    onSettled: refresh,
    onError: (e) => toast(t(errorKey(e))),
  });
  const handBack = useMutation({
    mutationFn: () => post('hand-back-to-ai'),
    onSettled: refresh,
    onError: (e) => toast(t(errorKey(e))),
  });

  const reasons = item.suggestedReasonCodes.map((code) => {
    const label = t(`leads.reason.${code}`);
    return label === `leads.reason.${code}` ? t('leads.reason.unknown') : label;
  });

  return (
    <section
      data-testid="lead-panel-ai"
      aria-label={t('leads.aiBlock')}
      className="flex flex-col gap-2 rounded-xl border border-line bg-canvas p-3 text-sm"
    >
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={item.stageSetBy === 'AGENT' ? 'accent' : 'neutral'}>
          {item.stageSetBy === 'AGENT'
            ? t('leads.stageByAI')
            : t('leads.stageByOperator')}
        </Badge>
      </p>
      {suggested ? (
        <div className="flex flex-col gap-2">
          <p data-testid="lead-panel-suggestion" className="font-medium">
            {t('leads.aiSuggestsChip', { stage: stageLabel(suggested, t) })}
          </p>
          {reasons.length > 0 ? (
            <p className="text-xs text-muted">{reasons.join(', ')}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={accept.isPending}
              data-testid="lead-accept-suggestion"
              onClick={() => accept.mutate()}
            >
              {t('leads.acceptSuggestion')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={dismiss.isPending}
              data-testid="lead-dismiss-suggestion"
              onClick={() => dismiss.mutate()}
            >
              {t('leads.dismissSuggestion')}
            </Button>
          </div>
        </div>
      ) : null}
      {item.stageSetBy === 'OPERATOR' ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            loading={handBack.isPending}
            data-testid="lead-hand-back-to-ai"
            onClick={() => handBack.mutate()}
          >
            {t('leads.handBackToAi')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
