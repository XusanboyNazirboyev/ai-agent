'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { BoardStageView, LeadPipelineItem } from '@/lib/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useToast } from './ui/toast';
import { currentStageId, stageLabel } from './lead-board-utils';

/** Who staged the lead; the AI suggestion; handing the lead back (ADR 058). */
export function LeadAiBlock(props: {
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
