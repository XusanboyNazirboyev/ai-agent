'use client';

import { useId, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import type { BoardStageView, LeadPipelineItem } from '@/lib/types';
import { currentStageId, stageLabel } from './lead-board-utils';

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

/** The stage steps of a lead: click a step to move the lead there. */
export function LeadStageStepper(props: {
  item: LeadPipelineItem;
  stages: BoardStageView[];
  canEdit: boolean;
  onRequestMove: (item: LeadPipelineItem, toStageId: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const { item, stages, canEdit } = props;
  const stageId = currentStageId(item, stages);
  const currentIndex = stages.findIndex((s) => s.id === stageId);
  const headingId = useId();
  return (
    <nav aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3
        id={headingId}
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
                  if (state !== 'current') props.onRequestMove(item, stage.id);
                }}
                className={`${STEP_BASE} ${stepClass(stage.kind, state)} disabled:cursor-default`}
              >
                <span className="block truncate">{stageLabel(stage, t)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
