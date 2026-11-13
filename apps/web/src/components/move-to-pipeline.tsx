'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { LeadStage, PipelineView } from '@/lib/types';
import { Button } from './ui/button';
import { FormDialog } from './ui/form-dialog';
import { useToast } from './ui/toast';

export function MoveToPipeline(props: { leadId: string }): ReactNode {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');

  const pipelines = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api<{ items: PipelineView[] }>('/api/v1/pipelines'),
    enabled: open,
  });
  const stages = useQuery({
    queryKey: ['lead-stages', pipelineId],
    queryFn: () =>
      api<LeadStage[]>(`/api/v1/leads/stages?pipelineId=${pipelineId}`),
    enabled: open && !!pipelineId,
  });

  const move = useMutation({
    mutationFn: () =>
      api(`/api/v1/leads/${props.leadId}/stage`, {
        method: 'PATCH',
        body: { stageId },
      }),
    onSuccess: () => {
      toast(t('toast.opportunitySaved'));
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
      void qc.invalidateQueries({ queryKey: ['lead-stages'] });
    },
  });

  const list = pipelines.data?.items ?? [];
  const stageList = stages.data ?? [];

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setOpen(true);
          setPipelineId('');
          setStageId('');
        }}
        data-testid="lead-move-pipeline"
      >
        {t('leads.moveToPipeline')}
      </Button>
      <FormDialog
        open={open}
        title={t('leads.moveToPipeline')}
        testId="move-pipeline-dialog"
        onClose={() => setOpen(false)}
        onSubmit={() => {
          if (stageId) move.mutate();
        }}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('app.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={move.isPending}
              disabled={!stageId}
            >
              {t('app.save')}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('pipelines.switcher')}
          <select
            value={pipelineId}
            onChange={(e) => {
              setPipelineId(e.target.value);
              setStageId('');
            }}
            className="min-h-9 rounded-lg border border-line bg-surface px-2 text-sm text-fg"
            aria-label={t('pipelines.switcher')}
          >
            <option value="">—</option>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? t('pipeline.defaultName')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('leads.moveToStage')}
          <select
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
            disabled={!pipelineId}
            className="min-h-9 rounded-lg border border-line bg-surface px-2 text-sm text-fg"
            aria-label={t('leads.moveToStage')}
          >
            <option value="">—</option>
            {stageList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? (s.code ? t(`leads.stage.${s.code}`) : s.id)}
              </option>
            ))}
          </select>
        </label>
        {move.isError ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(move.error))}
          </p>
        ) : null}
      </FormDialog>
    </>
  );
}
