'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { LeadStage, PipelineView } from '@/lib/types';
import { useToast } from './ui/toast';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { Select } from './ui/select';
import { stageLabel } from './lead-board-utils';

/** ADR 076: the API takes at most this many leads per request. */
export const BULK_CHUNK = 100;

type BulkBody =
  | { action: 'assign'; ownerOperatorId: string | null }
  | { action: 'move'; stageId: string; lostReason?: string };

interface BulkResult {
  updated: number;
  failed: Array<{ id: string; code: string }>;
}

/** Sends the leads in chunks; the totals of every chunk. */
export async function runBulk(
  leadIds: readonly string[],
  body: BulkBody,
): Promise<BulkResult> {
  const total: BulkResult = { updated: 0, failed: [] };
  for (let i = 0; i < leadIds.length; i += BULK_CHUNK) {
    const result = await api<BulkResult>('/api/v1/leads/bulk', {
      method: 'POST',
      body: { ...body, leadIds: leadIds.slice(i, i + BULK_CHUNK) },
    });
    total.updated += result.updated;
    total.failed.push(...result.failed);
  }
  return total;
}

function useBulkSubmit(onDone: () => void) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(
    leadIds: readonly string[],
    body: BulkBody,
  ): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const result = await runBulk(leadIds, body);
      toast(
        result.failed.length > 0
          ? `${t('leads.bulkDone', { count: result.updated })}. ${t('leads.bulkSkipped', { count: result.failed.length })}`
          : t('leads.bulkDone', { count: result.updated }),
      );
      onDone();
    } catch (e: unknown) {
      setError(t(errorKey(e)));
    } finally {
      setBusy(false);
      for (const key of ['board', 'leads', 'pipelines', 'lead'])
        void qc.invalidateQueries({ queryKey: [key] });
    }
  }
  return { busy, error, submit };
}

function DialogError(props: { message: string }): ReactNode {
  return props.message ? (
    <p
      role="alert"
      className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
    >
      {props.message}
    </p>
  ) : null;
}

/** Moves the selected leads to one stage of any pipeline. */
export function BulkMoveDialog(props: {
  leadIds: readonly string[];
  pipelines: readonly PipelineView[];
  pipelineId: string;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [pipelineId, setPipelineId] = useState(props.pipelineId);
  const [stageId, setStageId] = useState('');
  const [reason, setReason] = useState('');
  const stages = useQuery({
    queryKey: ['stages', pipelineId],
    queryFn: () =>
      api<LeadStage[]>(
        `/api/v1/leads/stages?pipelineId=${encodeURIComponent(pipelineId)}`,
      ),
  });
  const items = stages.data ?? [];
  const chosen = items.find((s) => s.id === stageId);
  const needsReason = chosen?.kind === 'LOST';
  const { busy, error, submit } = useBulkSubmit(props.onDone);
  const ready = !!chosen && (!needsReason || reason.trim() !== '');

  return (
    <FormDialog
      open
      title={t('leads.bulkMoveTitle')}
      description={t('leads.selectedCount', { count: props.leadIds.length })}
      testId="leads-bulk-move"
      onClose={props.onClose}
      onSubmit={() => {
        if (!ready || busy) return;
        void submit(props.leadIds, {
          action: 'move',
          stageId,
          ...(needsReason ? { lostReason: reason.trim() } : {}),
        });
      }}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!ready}
            loading={busy}
          >
            {t('leads.bulkApply')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {props.pipelines.length > 1 ? (
          <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
            {t('leads.bulkPipeline')}
            <Select
              field
              data-testid="leads-bulk-pipeline"
              value={pipelineId}
              onChange={(e) => {
                setPipelineId(e.target.value);
                setStageId('');
              }}
              className="w-full"
            >
              {props.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? t('pipeline.defaultName')}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {t('leads.bulkStage')}
          <Select
            field
            data-testid="leads-bulk-stage"
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
            className="w-full"
          >
            <option value="" disabled>
              {stages.isPending ? t('app.loading') : '—'}
            </option>
            {items.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stageLabel(stage, t)}
              </option>
            ))}
          </Select>
        </label>
        {needsReason ? (
          <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
            {t('opportunity.lostReason')}
            <input
              data-testid="leads-bulk-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              className={fieldClass}
            />
          </label>
        ) : null}
        <DialogError message={error} />
      </div>
    </FormDialog>
  );
}

/** Gives the selected leads one owner, or none (OWNER, ADMIN). */
export function BulkAssignDialog(props: {
  leadIds: readonly string[];
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [owner, setOwner] = useState('');
  const team = useQuery({
    queryKey: ['team'],
    queryFn: () =>
      api<{
        operators: { id: string; displayName: string; isActive: boolean }[];
      }>('/api/v1/team'),
  });
  const operators = (team.data?.operators ?? []).filter((o) => o.isActive);
  const { busy, error, submit } = useBulkSubmit(props.onDone);

  return (
    <FormDialog
      open
      title={t('leads.bulkAssignTitle')}
      description={t('leads.selectedCount', { count: props.leadIds.length })}
      testId="leads-bulk-assign"
      onClose={props.onClose}
      onSubmit={() => {
        if (!owner || busy) return;
        void submit(props.leadIds, {
          action: 'assign',
          ownerOperatorId: owner === 'none' ? null : owner,
        });
      }}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!owner}
            loading={busy}
          >
            {t('leads.bulkApply')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {t('leads.bulkOwner')}
          <Select
            field
            data-testid="leads-bulk-owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="w-full"
          >
            <option value="" disabled>
              {team.isPending ? t('app.loading') : '—'}
            </option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName}
              </option>
            ))}
            <option value="none">{t('leads.unassigned')}</option>
          </Select>
        </label>
        <DialogError message={error} />
      </div>
    </FormDialog>
  );
}
