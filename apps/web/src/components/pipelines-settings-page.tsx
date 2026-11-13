'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { LeadStage, PipelineView, Role } from '@/lib/types';
import { useShell } from './app-shell';
import { SettingsSubPage } from './settings-section-nav';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

function canManage(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

function stageName(stage: LeadStage, t: (key: string) => string): string {
  return stage.name ?? (stage.code ? t(`leads.stage.${stage.code}`) : '');
}

export function PipelinesSettingsPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const manage = canManage(operator.role);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renameTarget, setRenameTarget] = useState<PipelineView | null>(null);
  const [renameName, setRenameName] = useState('');
  const [defaultTarget, setDefaultTarget] = useState<PipelineView | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<PipelineView | null>(null);

  const pipelines = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api<{ items: PipelineView[] }>('/api/v1/pipelines'),
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['pipelines'] });
    void qc.invalidateQueries({ queryKey: ['lead-stages'] });
    void qc.invalidateQueries({ queryKey: ['leads'] });
  };

  const create = useMutation({
    mutationFn: (name: string) =>
      api<PipelineView>('/api/v1/pipelines', {
        method: 'POST',
        body: { name },
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setCreateName('');
      toast(t('toast.pipelineCreated'));
      invalidate();
    },
  });
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api<PipelineView>(`/api/v1/pipelines/${input.id}`, {
        method: 'PATCH',
        body: { name: input.name },
      }),
    onSuccess: () => {
      setRenameTarget(null);
      toast(t('toast.pipelineRenamed'));
      invalidate();
    },
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/pipelines/${id}/make-default`, { method: 'POST' }),
    onSuccess: () => {
      setDefaultTarget(null);
      toast(t('toast.pipelineDefault'));
      invalidate();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/pipelines/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setArchiveTarget(null);
      toast(t('toast.pipelineArchived'));
      invalidate();
    },
  });

  const list = pipelines.data?.items ?? [];
  const err =
    create.error ?? rename.error ?? makeDefault.error ?? archive.error;

  return (
    <SettingsSubPage active="pipeline">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('settings.section.pipeline')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold">{t('leadStages.title')}</h2>
              <p className="text-sm text-muted">{t('pipelines.intro')}</p>
            </div>
            {manage ? (
              <Button
                variant="primary"
                icon="plus"
                onClick={() => setCreateOpen(true)}
                data-testid="pipeline-create"
              >
                {t('pipelines.create')}
              </Button>
            ) : null}
          </div>
          {!manage ? (
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm text-muted">
              <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
              {t('settings.readOnly')}
            </p>
          ) : null}
          {err ? (
            <p role="alert" className="text-sm text-danger-fg">
              {t(errorKey(err))}
            </p>
          ) : null}
          {pipelines.isPending ? (
            <div role="status">
              <span className="sr-only">{t('app.loading')}</span>
              <SkeletonRows rows={3} />
            </div>
          ) : null}
          {pipelines.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm text-danger-fg">
                {t(errorKey(pipelines.error))}
              </p>
              <Button size="sm" onClick={() => void pipelines.refetch()}>
                {t('app.retry')}
              </Button>
            </div>
          ) : null}

          {pipelines.isSuccess ? (
            <ul className="flex flex-col gap-4" data-testid="pipelines-list">
              {list.map((pipeline) => (
                <PipelineCard
                  key={pipeline.id}
                  pipeline={pipeline}
                  manage={manage}
                  onRename={() => {
                    setRenameName(pipeline.name ?? '');
                    setRenameTarget(pipeline);
                  }}
                  onDefault={() => setDefaultTarget(pipeline)}
                  onArchive={() => setArchiveTarget(pipeline)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <FormDialog
        open={createOpen}
        title={t('pipelines.create')}
        testId="pipeline-create-dialog"
        onClose={() => setCreateOpen(false)}
        onSubmit={() => {
          const name = createName.trim();
          if (name) create.mutate(name);
        }}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              {t('app.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              {t('app.save')}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('pipelines.newName')}
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            maxLength={80}
            className={fieldClass}
            autoFocus
          />
        </label>
      </FormDialog>

      <FormDialog
        open={renameTarget !== null}
        title={t('pipelines.renameTitle')}
        testId="pipeline-rename-dialog"
        onClose={() => setRenameTarget(null)}
        onSubmit={() => {
          if (!renameTarget) return;
          const name = renameName.trim();
          if (name) rename.mutate({ id: renameTarget.id, name });
        }}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenameTarget(null)}>
              {t('app.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={rename.isPending}>
              {t('app.save')}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('pipelines.newName')}
          <input
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            maxLength={80}
            className={fieldClass}
            autoFocus
          />
        </label>
      </FormDialog>

      <ConfirmDialog
        open={defaultTarget !== null}
        title={t('pipelines.defaultTitle')}
        body={t('pipelines.defaultBody', {
          name: defaultTarget?.name ?? t('pipeline.defaultName'),
        })}
        confirmLabel={t('pipelines.makeDefault')}
        cancelLabel={t('app.cancel')}
        busy={makeDefault.isPending}
        onConfirm={() => defaultTarget && makeDefault.mutate(defaultTarget.id)}
        onCancel={() => !makeDefault.isPending && setDefaultTarget(null)}
      />
      <ConfirmDialog
        open={archiveTarget !== null}
        title={t('pipelines.archiveTitle')}
        body={t('pipelines.archiveBody', {
          name: archiveTarget?.name ?? t('pipeline.defaultName'),
        })}
        confirmLabel={t('pipelines.archive')}
        cancelLabel={t('app.cancel')}
        tone="danger"
        busy={archive.isPending}
        onConfirm={() => archiveTarget && archive.mutate(archiveTarget.id)}
        onCancel={() => !archive.isPending && setArchiveTarget(null)}
      />
    </SettingsSubPage>
  );
}

function PipelineCard(props: {
  pipeline: PipelineView;
  manage: boolean;
  onRename: () => void;
  onDefault: () => void;
  onArchive: () => void;
}): ReactNode {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [stageName, setStageName] = useState('');
  const [createKind, setCreateKind] = useState<'OPEN' | 'WON' | 'LOST'>('OPEN');

  const stages = useQuery({
    queryKey: ['lead-stages', props.pipeline.id],
    queryFn: () =>
      api<LeadStage[]>(`/api/v1/leads/stages?pipelineId=${props.pipeline.id}`),
  });
  const list = stages.data ?? [];

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['lead-stages', props.pipeline.id] });
    void qc.invalidateQueries({ queryKey: ['pipelines'] });
    void qc.invalidateQueries({ queryKey: ['leads'] });
  };

  const createStage = useMutation({
    mutationFn: (input: { name: string; kind: 'OPEN' | 'WON' | 'LOST' }) =>
      api<LeadStage>('/api/v1/leads/stages', {
        method: 'POST',
        body: {
          name: input.name,
          pipelineId: props.pipeline.id,
          kind: input.kind,
        },
      }),
    onSuccess: () => {
      setStageName('');
      setCreateKind('OPEN');
      toast(t('toast.stageCreated'));
      invalidate();
    },
  });
  const renameStage = useMutation({
    mutationFn: (input: {
      id: string;
      name: string;
      kind?: 'OPEN' | 'WON' | 'LOST';
    }) =>
      api<LeadStage>(`/api/v1/leads/stages/${input.id}`, {
        method: 'PATCH',
        body: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
        },
      }),
    onSuccess: () => {
      toast(t('toast.stageRenamed'));
      invalidate();
    },
  });
  const deleteStage = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/leads/stages/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast(t('toast.stageDeleted'));
      invalidate();
    },
  });
  const reorder = useMutation({
    mutationFn: (stageIds: string[]) =>
      api(`/api/v1/pipelines/${props.pipeline.id}/stages/order`, {
        method: 'PUT',
        body: { stageIds },
      }),
    onSuccess: () => {
      toast(t('toast.stageReordered'));
      invalidate();
    },
  });

  const updateAiStaging = useMutation({
    mutationFn: (aiStaging: 'OFF' | 'SUGGEST' | 'AUTO') =>
      api<PipelineView>(`/api/v1/pipelines/${props.pipeline.id}`, {
        method: 'PATCH',
        body: { aiStaging },
      }),
    onSuccess: () => {
      toast(t('toast.aiStagingUpdated'));
      invalidate();
    },
  });

  const updateStageKind = useMutation({
    mutationFn: (input: { id: string; kind: 'OPEN' | 'WON' | 'LOST' }) =>
      api<LeadStage>(`/api/v1/leads/stages/${input.id}`, {
        method: 'PATCH',
        body: { kind: input.kind },
      }),
    onSuccess: () => {
      invalidate();
    },
    onError: (e: unknown) => {
      toast(t(errorKey(e)));
    },
  });

  const move = (index: number, dir: -1 | 1): void => {
    const next = [...list];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorder.mutate(next.map((s) => s.id));
  };

  const name = props.pipeline.name ?? t('pipeline.defaultName');
  return (
    <li
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
      data-testid="pipeline-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold">{name}</h3>
            {props.pipeline.isDefault ? (
              <Badge tone="neutral">{t('pipelines.defaultBadge')}</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted">
            {t('pipelines.stagesCount', { count: props.pipeline.stageCount })} ·{' '}
            {t('pipelines.leadsCount', { count: props.pipeline.leadCount })}
          </p>
        </div>
        {props.manage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={props.onRename}
              data-testid="pipeline-rename"
            >
              {t('pipelines.rename')}
            </Button>
            {!props.pipeline.isDefault ? (
              <Button
                size="sm"
                onClick={props.onDefault}
                data-testid="pipeline-make-default"
              >
                {t('pipelines.makeDefault')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="danger"
              onClick={props.onArchive}
              data-testid="pipeline-archive"
            >
              {t('pipelines.archive')}
            </Button>
          </div>
        ) : null}
      </div>
      {props.manage ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted">
          <span className="shrink-0">{t('pipelines.aiStaging')}:</span>
          <select
            aria-label={t('pipelines.aiStaging')}
            data-testid="pipeline-ai-staging"
            value={props.pipeline.aiStaging ?? 'OFF'}
            onChange={(e) =>
              updateAiStaging.mutate(
                e.target.value as 'OFF' | 'SUGGEST' | 'AUTO',
              )
            }
            className={fieldClass}
            disabled={updateAiStaging.isPending}
          >
            <option value="OFF">{t('pipelines.aiStaging.off')}</option>
            <option value="SUGGEST">{t('pipelines.aiStaging.suggest')}</option>
            <option value="AUTO">{t('pipelines.aiStaging.auto')}</option>
          </select>
          <span className="truncate text-xs">
            {t('pipelines.aiStagingHint')}
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{t('pipelines.stages')}</h4>
        {stages.isPending ? <SkeletonRows rows={2} /> : null}
        {stages.isError ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(stages.error))}
          </p>
        ) : null}
        {list.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="pipeline-stages">
            {list.map((stage, idx) => (
              <StageRow
                key={stage.id}
                stage={stage}
                index={idx}
                total={list.length}
                pipelineIsDefault={props.pipeline.isDefault}
                manage={props.manage}
                onRename={(name) => renameStage.mutate({ id: stage.id, name })}
                onRenameKind={(kind) =>
                  updateStageKind.mutate({ id: stage.id, kind })
                }
                onDelete={() => deleteStage.mutate(stage.id)}
                onMove={move}
                busy={
                  renameStage.isPending ||
                  deleteStage.isPending ||
                  reorder.isPending
                }
              />
            ))}
          </ul>
        ) : null}
        {props.manage ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const v = stageName.trim();
              if (v) createStage.mutate({ name: v, kind: createKind });
            }}
          >
            <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm font-medium">
              {t('pipelines.stageName')}
              <input
                value={stageName}
                onChange={(e) => setStageName(e.target.value)}
                maxLength={80}
                className={fieldClass}
                data-testid="stage-add-name"
              />
            </label>
            <label className="flex min-w-0 basis-32 flex-col gap-1 text-sm font-medium sr-only">
              {t('pipelines.stageKind')}
              <select
                aria-label={t('pipelines.stageKind')}
                value={createKind}
                onChange={(e) =>
                  setCreateKind(e.target.value as 'OPEN' | 'WON' | 'LOST')
                }
                className={fieldClass}
                data-testid="stage-add-kind"
              >
                <option value="OPEN">{t('pipelines.stageKind.OPEN')}</option>
                <option value="WON">{t('pipelines.stageKind.WON')}</option>
                <option value="LOST">{t('pipelines.stageKind.LOST')}</option>
              </select>
            </label>
            <Button
              type="submit"
              size="sm"
              icon="plus"
              loading={createStage.isPending}
              disabled={!stageName.trim()}
              data-testid="stage-add"
            >
              {t('pipelines.stageAdd')}
            </Button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

function StageRow(props: {
  stage: LeadStage;
  index: number;
  total: number;
  pipelineIsDefault: boolean;
  manage: boolean;
  onRename: (name: string) => void;
  onRenameKind: (kind: 'OPEN' | 'WON' | 'LOST') => void;
  onDelete: () => void;
  onMove: (index: number, dir: -1 | 1) => void;
  busy: boolean;
}): ReactNode {
  const { t } = useI18n();
  const [value, setValue] = useState(stageName(props.stage, t));
  const [kind, setKind] = useState<'OPEN' | 'WON' | 'LOST'>(
    props.stage.kind ?? 'OPEN',
  );
  const codedDefault = props.stage.code !== null && props.pipelineIsDefault;
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-line p-2"
      data-testid="pipeline-stage-row"
    >
      {props.manage ? (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={80}
          disabled={props.busy}
          className={`${fieldClass} min-w-0 flex-1 basis-40`}
          aria-label={t('pipelines.stageName')}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {stageName(props.stage, t)}
        </span>
      )}
      {props.stage.code ? (
        <Badge tone="neutral">{props.stage.code}</Badge>
      ) : null}
      {props.manage ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            onClick={() => props.onRename(value.trim())}
            disabled={props.busy || !value.trim()}
            data-testid="stage-save"
          >
            {t('app.save')}
          </Button>
          <select
            aria-label={t('pipelines.stageKind')}
            data-testid="stage-kind"
            value={kind}
            onChange={(e) => {
              const next = e.target.value as 'OPEN' | 'WON' | 'LOST';
              setKind(next);
              props.onRenameKind(next);
            }}
            className={fieldClass}
            disabled={props.busy}
          >
            <option value="OPEN">{t('pipelines.stageKind.OPEN')}</option>
            <option value="WON">{t('pipelines.stageKind.WON')}</option>
            <option value="LOST">{t('pipelines.stageKind.LOST')}</option>
          </select>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => props.onMove(props.index, -1)}
            disabled={props.busy || props.index === 0}
            aria-label={t('pipelines.stageUp')}
            data-testid="stage-up"
          >
            ↑
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => props.onMove(props.index, 1)}
            disabled={props.busy || props.index === props.total - 1}
            aria-label={t('pipelines.stageDown')}
            data-testid="stage-down"
          >
            ↓
          </Button>
          {!codedDefault ? (
            <Button
              size="sm"
              variant="danger"
              onClick={props.onDelete}
              disabled={props.busy}
              data-testid="stage-delete"
            >
              {t('pipelines.stageDelete')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
