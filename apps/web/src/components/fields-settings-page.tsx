'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type {
  CustomFieldDef,
  CustomFieldEntity,
  CustomFieldType,
  Tag,
} from '@/lib/types';
import { useShell } from './app-shell';
import { SettingsSubPage } from './settings-section-nav';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { fieldClass, textareaClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Section } from './ui/section';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

const PALETTE = ['gray', 'blue', 'green', 'amber', 'red', 'purple'] as const;
const COLOR_DOT: Record<string, string> = {
  gray: 'bg-muted',
  blue: 'bg-primary-fg',
  green: 'bg-success-fg',
  amber: 'bg-warning-fg',
  red: 'bg-danger-fg',
  purple: 'bg-accent-fg',
};
const TYPES: CustomFieldType[] = [
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
];

function slugKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^([^a-z])/, 'f_$1')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export function FieldsSettingsPage(): ReactNode {
  const { t } = useI18n();
  return (
    <SettingsSubPage active="fields">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('fields.title')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">{t('fields.title')}</h2>
            <p className="text-sm text-muted">{t('fields.intro')}</p>
          </div>
          <TagsManager />
          <CustomFieldsManager />
        </div>
      </div>
    </SettingsSubPage>
  );
}

function TagsManager(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const canEdit = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [name, setName] = useState('');
  const [color, setColor] = useState('');
  const [archiveId, setArchiveId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ items: Tag[] }>('/api/v1/tags'),
  });
  const tags = query.data?.items ?? [];

  const create = useMutation({
    mutationFn: (body: { name: string; color?: string | null }) =>
      api<Tag>('/api/v1/tags', { method: 'POST', body }),
    onSuccess: () => {
      setName('');
      setColor('');
      toast(t('toast.tagCreated'));
      void qc.invalidateQueries({ queryKey: ['tags'] });
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tags/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setArchiveId(null);
      toast(t('toast.tagArchived'));
      void qc.invalidateQueries({ queryKey: ['tags'] });
      void qc.invalidateQueries({ queryKey: ['people'] });
      void qc.invalidateQueries({ queryKey: ['person'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
    },
  });

  const archiveTarget = archiveId ? tags.find((x) => x.id === archiveId) : null;
  const err = create.error ?? archive.error;

  return (
    <Section title={t('fields.tags')} icon="tag">
      <p className="text-sm text-muted">{t('fields.tagsIntro')}</p>
      {!canEdit ? (
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
      {canEdit ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const v = name.trim();
            if (!v) return;
            create.mutate({ name: v, color: color || null });
          }}
        >
          <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm font-medium">
            {t('fields.tagName')}
            <input
              data-testid="tag-name-input"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex min-w-0 flex-1 basis-36 flex-col gap-1 text-sm font-medium">
            {t('fields.tagColor')}
            <select
              data-testid="tag-color-select"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className={fieldClass}
            >
              <option value="">{t('fields.noColor')}</option>
              {PALETTE.map((c) => (
                <option key={c} value={c}>
                  {t(`fields.color.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            variant="primary"
            icon="plus"
            loading={create.isPending}
            disabled={!name.trim() || create.isPending}
            data-testid="tag-create"
          >
            {t('fields.createTag')}
          </Button>
        </form>
      ) : null}

      {query.isPending ? (
        <div role="status">
          <span className="sr-only">{t('app.loading')}</span>
          <SkeletonRows rows={3} />
        </div>
      ) : null}
      {query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(query.error))}
          </p>
          <Button size="sm" onClick={() => void query.refetch()}>
            {t('app.retry')}
          </Button>
        </div>
      ) : null}
      {query.isSuccess && tags.length === 0 ? (
        <p className="text-sm text-muted">{t('fields.noTags')}</p>
      ) : null}
      {tags.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="tag-list">
          {tags.map((tag) => (
            <li
              key={tag.id}
              data-testid="tag-row"
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`h-3 w-3 shrink-0 rounded-full ${tag.color ? (COLOR_DOT[tag.color] ?? 'bg-muted') : 'bg-surface-2 ring-1 ring-line'}`}
                />
                <span className="truncate font-medium">{tag.name}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>
                  {t('fields.usage.people', { count: tag.usage?.people ?? 0 })}
                </span>
                <span>
                  {t('fields.usage.leads', { count: tag.usage?.leads ?? 0 })}
                </span>
              </span>
              {canEdit ? (
                <Button
                  size="sm"
                  icon="trash"
                  onClick={() => setArchiveId(tag.id)}
                  data-testid="tag-archive"
                >
                  {t('fields.archiveTag')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={archiveTarget !== null}
        title={t('fields.archiveTagTitle')}
        body={t('fields.archiveTagBody', { name: archiveTarget?.name ?? '' })}
        confirmLabel={t('fields.archiveTag')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={archive.isPending}
        onConfirm={() => archiveId && archive.mutate(archiveId)}
        onCancel={() => !archive.isPending && setArchiveId(null)}
      />
    </Section>
  );
}

function CustomFieldsManager(): ReactNode {
  const { t } = useI18n();
  const [entity, setEntity] = useState<CustomFieldEntity>('PERSON');
  return (
    <Section title={t('fields.defs')} icon="sliders">
      <p className="text-sm text-muted">{t('fields.defsIntro')}</p>
      <div
        role="tablist"
        aria-label={t('fields.defs')}
        className="flex w-fit gap-1 rounded-xl bg-surface-2 p-1"
      >
        {(['PERSON', 'LEAD'] as const).map((e) => (
          <button
            key={e}
            type="button"
            role="tab"
            aria-selected={entity === e}
            onClick={() => setEntity(e)}
            className={`min-h-9 rounded-lg px-3 text-sm font-medium transition-colors ${
              entity === e
                ? 'bg-surface text-fg shadow-card'
                : 'text-muted hover:text-fg'
            }`}
          >
            {t(`fields.entity.${e === 'PERSON' ? 'person' : 'lead'}`)}
          </button>
        ))}
      </div>
      <CustomFieldEntityPanel entity={entity} />
    </Section>
  );
}

function CustomFieldEntityPanel(props: {
  entity: CustomFieldEntity;
}): ReactNode {
  const { entity } = props;
  const { t } = useI18n();
  const { operator } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const canEdit = operator.role === 'OWNER' || operator.role === 'ADMIN';

  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<CustomFieldType>('TEXT');
  const [optionsText, setOptionsText] = useState('');
  const [archiveId, setArchiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!keyTouched) setKey(slugKey(label));
  }, [label, keyTouched]);

  const query = useQuery({
    queryKey: ['custom-fields', entity],
    queryFn: () =>
      api<{ items: CustomFieldDef[] }>(
        `/api/v1/custom-fields?entity=${entity}`,
      ),
  });
  const defs = query.data?.items ?? [];
  const sorted = useMemo(
    () => [...defs].sort((a, b) => a.position - b.position),
    [defs],
  );

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['custom-fields'] });
    void qc.invalidateQueries({ queryKey: ['person'] });
    void qc.invalidateQueries({ queryKey: ['people'] });
    void qc.invalidateQueries({ queryKey: ['leads'] });
  };

  const create = useMutation({
    mutationFn: (body: {
      entity: CustomFieldEntity;
      key: string;
      label: string;
      type: CustomFieldType;
      options?: string[];
    }) =>
      api<CustomFieldDef>('/api/v1/custom-fields', { method: 'POST', body }),
    onSuccess: () => {
      setLabel('');
      setKey('');
      setKeyTouched(false);
      setType('TEXT');
      setOptionsText('');
      toast(t('toast.fieldCreated'));
      invalidate();
    },
  });
  const patch = useMutation({
    mutationFn: (body: {
      id: string;
      label?: string;
      options?: string[] | null;
      position?: number;
    }) =>
      api<CustomFieldDef>(`/api/v1/custom-fields/${body.id}`, {
        method: 'PATCH',
        body: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.options !== undefined ? { options: body.options } : {}),
          ...(body.position !== undefined ? { position: body.position } : {}),
        },
      }),
    onSuccess: () => {
      toast(t('toast.fieldUpdated'));
      invalidate();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/custom-fields/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setArchiveId(null);
      toast(t('toast.fieldArchived'));
      invalidate();
    },
  });

  const archiveTarget = archiveId ? defs.find((d) => d.id === archiveId) : null;
  const err = create.error ?? patch.error ?? archive.error;

  function parseOptions(): string[] | undefined {
    if (type !== 'SELECT') return undefined;
    return optionsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`fields-panel-${entity}`}>
      {!canEdit ? (
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

      {canEdit ? (
        <form
          className="flex flex-col gap-3 rounded-xl border border-dashed border-line p-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const l = label.trim();
            const k = key.trim();
            if (!l || !k) return;
            // The API takes exactly these fields (strict body) and appends the
            // definition itself; options only exist for SELECT.
            const options = type === 'SELECT' ? parseOptions() : null;
            create.mutate({
              entity,
              key: k,
              label: l,
              type,
              ...(options ? { options } : {}),
            });
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t('fields.defLabel')}
              <input
                data-testid="def-label-input"
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
                className={fieldClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t('fields.defKey')}
              <input
                data-testid="def-key-input"
                value={key}
                maxLength={40}
                onChange={(e) => {
                  setKeyTouched(true);
                  setKey(e.target.value);
                }}
                className={fieldClass}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('fields.defType')}
            <select
              data-testid="def-type-select"
              value={type}
              onChange={(e) => setType(e.target.value as CustomFieldType)}
              className={fieldClass}
            >
              {TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {t(`fields.type.${tp}`)}
                </option>
              ))}
            </select>
          </label>
          {type === 'SELECT' ? (
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t('fields.defOptions')}
              <textarea
                data-testid="def-options-input"
                value={optionsText}
                rows={4}
                onChange={(e) => setOptionsText(e.target.value)}
                className={textareaClass}
              />
              <span className="text-xs font-normal text-muted">
                {t('fields.defOptionsHint')}
              </span>
            </label>
          ) : null}
          <div>
            <Button
              type="submit"
              variant="primary"
              icon="plus"
              loading={create.isPending}
              disabled={!label.trim() || !key.trim() || create.isPending}
              data-testid="def-create"
            >
              {t('fields.createDef')}
            </Button>
          </div>
        </form>
      ) : null}

      {query.isPending ? (
        <div role="status">
          <span className="sr-only">{t('app.loading')}</span>
          <SkeletonRows rows={3} />
        </div>
      ) : null}
      {query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(query.error))}
          </p>
          <Button size="sm" onClick={() => void query.refetch()}>
            {t('app.retry')}
          </Button>
        </div>
      ) : null}
      {query.isSuccess && sorted.length === 0 ? (
        <p className="text-sm text-muted">{t('fields.noDefs')}</p>
      ) : null}
      {sorted.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="def-list">
          {sorted.map((def, idx) => (
            <li
              key={def.id}
              data-testid="def-row"
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-line p-3"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{def.label}</span>
                <span className="truncate text-xs text-muted">
                  {def.key} · {t(`fields.type.${def.type}`)}
                </span>
              </span>
              {canEdit ? (
                <span className="flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    disabled={idx === 0 || patch.isPending}
                    onClick={() =>
                      patch.mutate({ id: def.id, position: def.position - 1 })
                    }
                    aria-label={t('fields.moveUp')}
                    data-testid="def-move-up"
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    disabled={idx === sorted.length - 1 || patch.isPending}
                    onClick={() =>
                      patch.mutate({ id: def.id, position: def.position + 1 })
                    }
                    aria-label={t('fields.moveDown')}
                    data-testid="def-move-down"
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    icon="trash"
                    onClick={() => setArchiveId(def.id)}
                    data-testid="def-archive"
                  >
                    {t('fields.archiveDef')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={archiveTarget !== null}
        title={t('fields.archiveDefTitle')}
        body={t('fields.archiveDefBody', { label: archiveTarget?.label ?? '' })}
        confirmLabel={t('fields.archiveDef')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={archive.isPending}
        onConfirm={() => archiveId && archive.mutate(archiveId)}
        onCancel={() => !archive.isPending && setArchiveId(null)}
      />
    </div>
  );
}
