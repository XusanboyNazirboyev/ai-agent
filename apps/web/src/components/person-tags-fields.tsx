'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type {
  CustomFieldEntry,
  CustomFieldType,
  CustomFieldValue,
  PersonDetail,
  Role,
  Tag,
  TagRef,
} from '@/lib/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Section } from './ui/section';
import { useToast } from './ui/toast';

const COLOR_TONE: Record<
  string,
  'neutral' | 'accent' | 'success' | 'warning' | 'danger'
> = {
  gray: 'neutral',
  blue: 'accent',
  green: 'success',
  amber: 'warning',
  red: 'danger',
  purple: 'accent',
};

function canEditTags(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'OPERATOR';
}

export function PersonTagsSection(props: {
  person: PersonDetail;
  role: Role;
}): ReactNode {
  const { person, role } = props;
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const tags = person.tags ?? [];
  const editable = canEditTags(role);
  const [open, setOpen] = useState(false);

  const allTags = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ items: Tag[] }>('/api/v1/tags'),
    enabled: open && editable,
  });

  const save = useMutation({
    mutationFn: (tagIds: string[]) =>
      api(`/api/v1/people/${person.id}/tags`, {
        method: 'PUT',
        body: { tagIds },
      }),
    onSuccess: () => {
      toast(t('toast.tagsSaved'));
      void qc.invalidateQueries({ queryKey: ['person', person.id] });
      void qc.invalidateQueries({ queryKey: ['people'] });
    },
  });

  const available = (allTags.data?.items ?? []).filter(
    (tag) => !tags.some((t) => t.id === tag.id),
  );

  function remove(tag: TagRef): void {
    save.mutate(tags.filter((x) => x.id !== tag.id).map((x) => x.id));
  }
  function add(tagId: string): void {
    if (!tagId) return;
    save.mutate([...tags.map((x) => x.id), tagId]);
    setOpen(false);
  }

  return (
    <Section title={t('people.tags')} icon="tag" testId="person-tags" level={2}>
      <div className="flex flex-wrap items-center gap-2">
        {tags.length === 0 ? (
          <span className="text-sm text-muted">{t('people.noTags')}</span>
        ) : null}
        {tags.map((tag) => (
          <span
            key={tag.id}
            data-testid="person-tag-chip"
            className="inline-flex items-center gap-1"
          >
            <Badge
              tone={
                tag.color ? (COLOR_TONE[tag.color] ?? 'neutral') : 'neutral'
              }
            >
              {tag.name}
            </Badge>
            {editable ? (
              <button
                type="button"
                aria-label={t('people.removeTag', { name: tag.name })}
                data-testid="person-tag-remove"
                disabled={save.isPending}
                onClick={() => remove(tag)}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              >
                <Icon name="x" className="h-3 w-3" />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          {open ? (
            <>
              <select
                aria-label={t('people.addTag')}
                data-testid="person-tag-select"
                defaultValue=""
                onChange={(e) => add(e.target.value)}
                className={`${fieldClass} max-w-xs`}
              >
                <option value="">{t('people.addTag')}</option>
                {available.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => setOpen(false)}>
                {t('confirm.cancel')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              icon="plus"
              onClick={() => setOpen(true)}
              data-testid="person-tag-add"
              disabled={save.isPending}
            >
              {t('people.addTag')}
            </Button>
          )}
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t(errorKey(save.error))}
        </p>
      ) : null}
    </Section>
  );
}

export function PersonCustomFieldsSection(props: {
  person: PersonDetail;
  role: Role;
}): ReactNode {
  const { person, role } = props;
  const { t } = useI18n();
  const fields = person.customFields ?? [];
  const editable = canEditTags(role);

  return (
    <Section
      title={t('people.customFields')}
      icon="sliders"
      testId="person-custom-fields"
      level={2}
    >
      {fields.length === 0 ? (
        <p className="text-sm text-muted">{t('people.noCustomFields')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {fields.map((field) => (
            <PersonFieldRow
              key={field.key}
              personId={person.id}
              field={field}
              editable={editable}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function PersonFieldRow(props: {
  personId: string;
  field: CustomFieldEntry;
  editable: boolean;
}): ReactNode {
  const { personId, field, editable } = props;
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>(() =>
    toDraft(field.type, field.value),
  );
  const [touched, setTouched] = useState(false);
  const value = touched ? draft : toDraft(field.type, field.value);

  const save = useMutation({
    mutationFn: (next: CustomFieldValue) =>
      api(`/api/v1/people/${personId}/custom-fields`, {
        method: 'PATCH',
        body: { values: { [field.key]: next } },
      }),
    onSuccess: () => {
      setTouched(false);
      toast(t('toast.fieldSaved'));
      void qc.invalidateQueries({ queryKey: ['person', personId] });
    },
  });

  function onSave(): void {
    save.mutate(fromDraft(field.type, value));
  }

  return (
    <li
      data-testid="person-custom-field"
      data-field-key={field.key}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-line p-3"
    >
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-sm font-medium">
          <span className="text-xs text-muted">{field.label}</span>
          <FieldEditor
            type={field.type}
            value={value}
            disabled={!editable || save.isPending}
            label={field.label}
            onChange={(v) => {
              setTouched(true);
              setDraft(v);
            }}
          />
        </label>
        {editable ? (
          <Button
            size="sm"
            onClick={onSave}
            loading={save.isPending}
            disabled={save.isPending}
            data-testid="person-field-save"
          >
            {t('people.saveField')}
          </Button>
        ) : null}
      </div>
      {!editable && field.value === null ? (
        <p className="text-xs text-muted">{t('people.fieldEmpty')}</p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t(errorKey(save.error))}
        </p>
      ) : null}
    </li>
  );
}

function FieldEditor(props: {
  type: CustomFieldType;
  value: string;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
}): ReactNode {
  const { type, value, disabled, label, onChange } = props;
  if (type === 'BOOLEAN') {
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value === 'true'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        className="h-5 w-5 accent-primary-fg"
      />
    );
  }
  if (type === 'SELECT') {
    return (
      <input
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  }
  if (type === 'NUMBER') {
    return (
      <input
        type="number"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  }
  if (type === 'DATE') {
    return (
      <input
        type="date"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  }
  return (
    <input
      type="text"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={fieldClass}
    />
  );
}

function toDraft(type: CustomFieldType, value: CustomFieldValue): string {
  if (value === null || value === undefined)
    return type === 'BOOLEAN' ? 'false' : '';
  if (type === 'BOOLEAN') return value ? 'true' : 'false';
  return String(value);
}

function fromDraft(type: CustomFieldType, draft: string): CustomFieldValue {
  if (type === 'BOOLEAN') return draft === 'true';
  if (draft === '') return null;
  if (type === 'NUMBER') {
    const n = Number(draft);
    return Number.isFinite(n) ? n : null;
  }
  return draft;
}
