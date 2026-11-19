'use client';

import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import type { BoardStageView, LeadPipelineItem } from '@/lib/types';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { currentStageId } from './lead-board-utils';
import { useLeadMove } from './lead-move';

/**
 * Moving a lead to a stage; a LOST stage asks for the reason first (the same
 * rule as the board). `dialog` must be rendered by the caller.
 */
export function useLeadStageMove(stages: BoardStageView[]): {
  requestMove: (item: LeadPipelineItem, toStageId: string) => void;
  dialog: ReactNode;
} {
  const { t } = useI18n();
  const move = useLeadMove();
  const [lost, setLost] = useState<{
    leadId: string;
    fromStageId: string;
    toStageId: string;
  } | null>(null);
  const [reason, setReason] = useState('');

  function requestMove(item: LeadPipelineItem, toStageId: string): void {
    const from = currentStageId(item, stages);
    if (from === toStageId) return;
    if (stages.find((s) => s.id === toStageId)?.kind === 'LOST') {
      setReason('');
      setLost({ leadId: item.id, fromStageId: from, toStageId });
      return;
    }
    move.mutate({ leadId: item.id, fromStageId: from, toStageId });
  }

  const dialog = (
    <FormDialog
      open={lost !== null}
      title={t('opportunity.lostReason')}
      description={t('opportunity.lostReasonBody')}
      testId="lead-lost-dialog"
      onClose={() => setLost(null)}
      onSubmit={() => {
        const text = reason.trim();
        if (!text || !lost) return;
        move.mutate({ ...lost, lostReason: text });
        setLost(null);
      }}
      footer={
        <>
          <Button variant="secondary" onClick={() => setLost(null)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" variant="primary">
            {t('app.save')}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t('opportunity.lostReason')}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          className={fieldClass}
          autoFocus
          aria-label={t('opportunity.lostReason')}
        />
      </label>
    </FormDialog>
  );
  return { requestMove, dialog };
}
