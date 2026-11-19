'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { StageSyncView } from '@/lib/types';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';
import { stageLabel } from './lead-board-utils';

/** Plain-words key for the error code of the last run. */
function errorWords(code: string): string {
  if (code === 'MAPPING_INVALID') return 'crmSync.err.mapping';
  if (code.includes('NO_AUTH') || code.includes('INVALID_CREDENTIALS'))
    return 'crmSync.err.auth';
  return 'crmSync.err.other';
}

/** Stage sync of a connected Bitrix24 (ADR 079): on/off and the stage mapping. */
export function CrmStageSync(props: { connectorId: string }): ReactNode {
  const { t, formatDateTime } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const key = ['connectors', 'stage-sync', props.connectorId];
  const path = `/api/v1/connectors/${props.connectorId}/stage-sync`;
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<StageSyncView>(path),
  });
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!query.data) return;
    setEnabled(query.data.enabled);
    setDraft(
      Object.fromEntries(
        query.data.stages.map((s) => [s.externalStageId, s.leadStageId ?? '']),
      ),
    );
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      api<StageSyncView>(path, {
        method: 'PUT',
        body: {
          enabled,
          mappings: Object.entries(draft).map(([externalStageId, id]) => ({
            externalStageId,
            leadStageId: id || null,
          })),
        },
      }),
    onSuccess: (view) => {
      client.setQueryData(key, view);
      toast(t('crmSync.saved'));
    },
  });

  const view = query.data;
  return (
    <div
      data-testid="crm-stage-sync"
      className="flex min-w-0 flex-col gap-3 border-t border-line pt-3"
    >
      <h3 className="font-medium">{t('crmSync.title')}</h3>
      <p className="text-sm text-muted">{t('crmSync.desc')}</p>
      {query.isPending ? <SkeletonRows rows={3} /> : null}
      {query.isError ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t(errorKey(query.error))}
        </p>
      ) : null}
      {view ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              role="switch"
              data-testid="stage-sync-enabled"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t('crmSync.enable')}
          </label>
          {!view.portalReachable ? (
            <p className="text-sm text-warning-fg">
              {t('crmSync.unreachable')}
            </p>
          ) : null}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-2 font-normal">
                  {t('crmSync.portalStage')}
                </th>
                <th className="py-1 font-normal">{t('crmSync.ourStage')}</th>
              </tr>
            </thead>
            <tbody>
              {view.stages.map((stage) => (
                <tr key={stage.externalStageId}>
                  <td className="py-1 pr-2 break-words">{stage.name}</td>
                  <td className="py-1">
                    <Select
                      compact
                      aria-label={stage.name}
                      data-testid={`stage-map-${stage.externalStageId}`}
                      value={draft[stage.externalStageId] ?? ''}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          [stage.externalStageId]: event.target.value,
                        })
                      }
                    >
                      <option value="">{t('crmSync.ignore')}</option>
                      {view.ourStages.map((ours) => (
                        <option key={ours.id} value={ours.id}>
                          {stageLabel(ours, t)}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm text-muted" data-testid="stage-sync-status">
            {view.lastRunAt
              ? t('crmSync.lastRun', { time: formatDateTime(view.lastRunAt) })
              : t('crmSync.neverRun')}
          </p>
          {view.lastErrorCode ? (
            <p
              role="alert"
              className="text-sm text-danger-fg"
              data-testid="stage-sync-error"
            >
              {t(errorWords(view.lastErrorCode))}
            </p>
          ) : null}
          {save.error ? (
            <p role="alert" className="text-sm text-danger-fg">
              {t(errorKey(save.error))}
            </p>
          ) : null}
          <div>
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              data-testid="stage-sync-save"
            >
              {t('crmSync.save')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
