'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type {
  CustomFieldDef,
  CustomFieldEntry,
  CustomFieldType,
  CustomFieldValue,
  Role,
} from '@/lib/types';
import { slugKey } from './fields-settings-page';
import { Button } from './ui/button';
import { fieldClass, textareaClass } from './ui/fields';
import { Select } from './ui/select';
import { useToast } from './ui/toast';

const TYPES: CustomFieldType[] = [
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
];

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

/**
 * "Main information": the lead's custom fields, always visible and editable
 * in place (saved when the field loses focus or changes). OWNER/ADMIN can add
 * a new field definition here.
 */
export function LeadMainInfo(props: {
  leadId: string;
  fields: CustomFieldEntry[];
  role: Role;
}): ReactNode {
  const { t } = useI18n();
  const editable = props.role !== 'VIEWER';
  const canDefine = props.role === 'OWNER' || props.role === 'ADMIN';
  const defs = useQuery({
    queryKey: ['custom-fields', 'LEAD'],
    queryFn: () =>
      api<{ items: CustomFieldDef[] }>('/api/v1/custom-fields?entity=LEAD'),
  });
  const optionsOf = (key: string): string[] =>
    defs.data?.items.find((d) => d.key === key)?.options ?? [];
  return (
    <section
      data-testid="lead-main-info"
      aria-label={t('leadPage.mainInfo')}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 shadow-card"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t('leadPage.mainInfo')}
      </h2>
      {props.fields.length === 0 ? (
        <p className="text-sm text-muted">{t('leadPage.noFields')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {props.fields.map((field) => (
            <InfoField
              key={field.key}
              leadId={props.leadId}
              field={field}
              options={optionsOf(field.key)}
              editable={editable}
            />
          ))}
        </ul>
      )}
      {canDefine ? <AddField /> : null}
    </section>
  );
}

function InfoField(props: {
  leadId: string;
  field: CustomFieldEntry;
  options: string[];
  editable: boolean;
}): ReactNode {
  const { field } = props;
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const saved = toDraft(field.type, field.value);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const save = useMutation({
    mutationFn: (next: string) =>
      api(`/api/v1/leads/${props.leadId}/custom-fields`, {
        method: 'PATCH',
        body: { values: { [field.key]: fromDraft(field.type, next) } },
      }),
    onSuccess: () => {
      setDraft(null);
      toast(t('toast.fieldSaved'));
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
      void qc.invalidateQueries({ queryKey: ['lead-timeline'] });
    },
  });
  const disabled = !props.editable || save.isPending;
  const commit = (next: string): void => {
    if (next !== saved) save.mutate(next);
    else setDraft(null);
  };
  const common = {
    'aria-label': field.label,
    disabled,
    'data-testid': 'lead-info-input',
  } as const;
  let input: ReactNode;
  if (field.type === 'BOOLEAN')
    input = (
      <input
        {...common}
        type="checkbox"
        checked={value === 'true'}
        onChange={(e) => commit(e.target.checked ? 'true' : 'false')}
        className="h-5 w-5 accent-primary-fg"
      />
    );
  else if (field.type === 'SELECT')
    input = (
      <Select
        compact
        {...common}
        value={value}
        onChange={(e) => commit(e.target.value)}
      >
        <option value="" />
        {[...new Set([...props.options, ...(value ? [value] : [])])].map(
          (o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ),
        )}
      </Select>
    );
  else
    input = (
      <input
        {...common}
        type={
          field.type === 'NUMBER'
            ? 'number'
            : field.type === 'DATE'
              ? 'date'
              : 'text'
        }
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(value);
        }}
        className={fieldClass}
      />
    );
  return (
    <li
      data-testid="lead-info-field"
      data-field-key={field.key}
      className="flex min-w-0 flex-col gap-1"
    >
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
        {field.label}
        {input}
      </label>
      {save.isError ? (
        <p role="alert" className="text-xs text-danger-fg">
          {t(errorKey(save.error))}
        </p>
      ) : null}
    </li>
  );
}

function AddField(): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldType>('TEXT');
  const [optionsText, setOptionsText] = useState('');
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/api/v1/custom-fields', { method: 'POST', body }),
    onSuccess: () => {
      setOpen(false);
      setLabel('');
      setType('TEXT');
      setOptionsText('');
      toast(t('toast.fieldCreated'));
      void qc.invalidateQueries({ queryKey: ['custom-fields'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
    },
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    const text = label.trim();
    const key = slugKey(text);
    if (!text || !key) return;
    const options =
      type === 'SELECT'
        ? optionsText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    create.mutate({
      entity: 'LEAD',
      key,
      label: text,
      type,
      ...(options ? { options } : {}),
    });
  }
  if (!open)
    return (
      <div>
        <Button
          size="sm"
          icon="plus"
          data-testid="lead-add-field"
          onClick={() => setOpen(true)}
        >
          {t('leadPage.addField')}
        </Button>
      </div>
    );
  return (
    <form
      onSubmit={submit}
      data-testid="lead-add-field-form"
      className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3"
    >
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t('fields.defLabel')}
        <input
          value={label}
          maxLength={80}
          onChange={(e) => setLabel(e.target.value)}
          className={fieldClass}
          data-testid="lead-add-field-label"
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t('fields.defType')}
        <Select
          compact
          value={type}
          onChange={(e) => setType(e.target.value as CustomFieldType)}
          data-testid="lead-add-field-type"
        >
          {TYPES.map((tp) => (
            <option key={tp} value={tp}>
              {t(`fields.type.${tp}`)}
            </option>
          ))}
        </Select>
      </label>
      {type === 'SELECT' ? (
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t('fields.defOptions')}
          <textarea
            rows={3}
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            placeholder={t('fields.defOptionsHint')}
            className={`${textareaClass} text-sm`}
          />
        </label>
      ) : null}
      {create.isError ? (
        <p role="alert" className="text-xs text-danger-fg">
          {t(errorKey(create.error))}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          loading={create.isPending}
          disabled={!label.trim()}
          data-testid="lead-add-field-submit"
        >
          {t('fields.createDef')}
        </Button>
        <Button size="sm" onClick={() => setOpen(false)}>
          {t('confirm.cancel')}
        </Button>
      </div>
    </form>
  );
}
