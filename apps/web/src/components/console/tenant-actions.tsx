'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import type { TenantOptions, TenantStatus } from '@/lib/platform-types';
import { Button } from '../ui/button';
import { ErrorNote } from '../ui/error-note';
import { fieldClass, textareaClass } from '../ui/fields';
import { FormDialog } from '../ui/form-dialog';
import { MIN_REASON, ReasonDialog } from '../ui/reason-dialog';
import { Select } from '../ui/select';
import { useConsole } from './console-shell';
import { useLocaleName } from './new-customer-dialog';

/** What the console can change on a customer (ADR 047 amendment 2026-11-17). */
export interface EditableTenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  defaultLocale: string;
  timezone: string;
  packKey: string;
  packVersion: string;
}

type StatusAction = 'suspend' | 'reactivate' | 'archive';

const TARGET: Record<StatusAction, TenantStatus> = {
  suspend: 'SUSPENDED',
  reactivate: 'ACTIVE',
  archive: 'ARCHIVED',
};

function statusActions(status: TenantStatus): StatusAction[] {
  if (status === 'ACTIVE') return ['suspend', 'archive'];
  if (status === 'SUSPENDED') return ['reactivate', 'archive'];
  return ['reactivate'];
}

/**
 * Edit, status and delete buttons for one customer, with their dialogs. Used
 * on the customer list and on the customer page; read-only admins see none.
 */
export function TenantActions(props: {
  tenant: EditableTenant;
  /** Called after the customer was deleted (the page leaves it). */
  onDeleted?: () => void;
}): ReactNode {
  const { t } = useI18n();
  const { canWrite } = useConsole();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<StatusAction | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { tenant } = props;

  const status = useMutation({
    mutationFn: (input: { status: TenantStatus; reason: string }) =>
      platformApi(`/api/v1/platform/tenants/${tenant.id}`, {
        method: 'PATCH',
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      setAction(null);
    },
  });
  useEffect(() => {
    if (action === null) status.reset();
  }, [action]);

  if (!canWrite) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="tenant-actions"
    >
      <Button
        size="sm"
        data-testid="tenant-edit"
        onClick={() => setEditing(true)}
      >
        {t('console.tenant.edit')}
      </Button>
      {statusActions(tenant.status).map((item) => (
        <Button
          key={item}
          size="sm"
          variant={item === 'reactivate' ? 'primary' : 'danger'}
          data-testid={`tenant-${item}`}
          onClick={() => setAction(item)}
        >
          {t(`console.tenant.${item}`)}
        </Button>
      ))}
      {tenant.status === 'ARCHIVED' ? (
        <Button
          size="sm"
          variant="danger"
          data-testid="tenant-delete"
          onClick={() => setDeleting(true)}
        >
          {t('console.tenant.delete')}
        </Button>
      ) : null}

      <ReasonDialog
        open={action !== null}
        testId="status-dialog"
        title={action ? t(`console.tenant.${action}Title`) : ''}
        body={action ? t(`console.tenant.${action}Body`) : ''}
        confirmLabel={action ? t(`console.tenant.${action}`) : ''}
        tone={action === 'reactivate' ? 'primary' : 'danger'}
        busy={status.isPending}
        error={status.error}
        onConfirm={(reason) => {
          if (action) status.mutate({ status: TARGET[action], reason });
        }}
        onCancel={() => setAction(null)}
      />
      <TenantEditDialog
        tenant={tenant}
        open={editing}
        onClose={() => setEditing(false)}
      />
      <TenantDeleteDialog
        tenant={tenant}
        open={deleting}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          props.onDeleted?.();
        }}
      />
    </div>
  );
}

function TenantEditDialog(props: {
  tenant: EditableTenant;
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const localeName = useLocaleName();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const { tenant } = props;
  const currentPack = `${tenant.packKey}@${tenant.packVersion}`;
  const [name, setName] = useState(tenant.name);
  const [locale, setLocale] = useState(tenant.defaultLocale);
  const [timezone, setTimezone] = useState(tenant.timezone);
  const [pack, setPack] = useState(currentPack);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setName(tenant.name);
    setLocale(tenant.defaultLocale);
    setTimezone(tenant.timezone);
    setPack(currentPack);
    setReason('');
  }, [props.open]);

  const options = useQuery({
    queryKey: ['platform', 'tenant-options'],
    queryFn: () =>
      platformApi<TenantOptions>('/api/v1/platform/tenants/options'),
    enabled: props.open,
  });
  const save = useMutation({
    mutationFn: (body: Record<string, string>) =>
      platformApi(`/api/v1/platform/tenants/${tenant.id}`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      props.onClose();
    },
  });
  useEffect(() => {
    if (!props.open) save.reset();
  }, [props.open]);

  const changes: Record<string, string> = {
    ...(name.trim() !== tenant.name ? { name: name.trim() } : {}),
    ...(locale !== tenant.defaultLocale ? { defaultLocale: locale } : {}),
    ...(timezone.trim() !== tenant.timezone
      ? { timezone: timezone.trim() }
      : {}),
    ...(pack !== currentPack ? { pack } : {}),
  };
  const changed = Object.keys(changes).length > 0;
  const valid =
    changed &&
    name.trim() !== '' &&
    timezone.trim() !== '' &&
    reason.trim().length >= MIN_REASON;
  const packs = options.data?.packs ?? [];
  const locales = options.data?.locales ?? [];

  return (
    <FormDialog
      open={props.open}
      title={t('console.tenant.editTitle')}
      description={t('console.tenant.editBody')}
      testId="tenant-edit-dialog"
      onClose={props.onClose}
      onSubmit={() => {
        if (valid && !save.isPending)
          save.mutate({ ...changes, reason: reason.trim() });
      }}
      footer={
        <>
          <Button onClick={props.onClose} data-testid="dialog-cancel">
            {t('confirm.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!valid}
            loading={save.isPending}
            data-testid="tenant-edit-save"
          >
            {t('console.tenant.editSave')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
          {t('console.field.name')}
          <input
            data-testid="tenant-edit-name"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('console.field.pack')}
          <Select
            field
            className="w-full"
            data-testid="tenant-edit-pack"
            value={pack}
            onChange={(e) => setPack(e.target.value)}
          >
            {(packs.includes(currentPack)
              ? packs
              : [currentPack, ...packs]
            ).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('console.field.locale')}
          <Select
            field
            className="w-full"
            data-testid="tenant-edit-locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
          >
            {(locales.includes(locale) ? locales : [locale, ...locales]).map(
              (id) => (
                <option key={id} value={id}>
                  {localeName(id)}
                </option>
              ),
            )}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
          {t('console.field.timezone')}
          <input
            data-testid="tenant-edit-timezone"
            required
            maxLength={64}
            autoCapitalize="off"
            spellCheck={false}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className={fieldClass}
          />
        </label>
        {pack !== currentPack ? (
          <p
            role="note"
            className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-fg sm:col-span-2"
          >
            {t('console.tenant.packChangeHint')}
          </p>
        ) : null}
        <label
          htmlFor={reasonId}
          className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2"
        >
          {t('console.reason')}
          <textarea
            id={reasonId}
            data-testid="tenant-edit-reason"
            required
            minLength={MIN_REASON}
            maxLength={500}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={textareaClass}
          />
        </label>
        <div className="sm:col-span-2">
          <ErrorNote error={save.error ?? options.error} />
        </div>
      </div>
    </FormDialog>
  );
}

function TenantDeleteDialog(props: {
  tenant: EditableTenant;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}): ReactNode {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const confirmId = useId();
  const reasonId = useId();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!props.open) return;
    setTyped('');
    setReason('');
  }, [props.open]);

  const remove = useMutation({
    mutationFn: () =>
      platformApi(`/api/v1/platform/tenants/${props.tenant.id}`, {
        method: 'DELETE',
        body: { confirmSlug: typed.trim(), reason: reason.trim() },
      }),
    onSuccess: () => {
      queryClient.removeQueries({
        queryKey: ['platform', 'tenant', props.tenant.id],
      });
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      props.onDeleted();
    },
  });
  useEffect(() => {
    if (!props.open) remove.reset();
  }, [props.open]);

  const valid =
    typed.trim() === props.tenant.slug && reason.trim().length >= MIN_REASON;

  return (
    <FormDialog
      open={props.open}
      title={t('console.tenant.deleteTitle')}
      description={t('console.tenant.deleteBody')}
      testId="tenant-delete-dialog"
      onClose={props.onClose}
      onSubmit={() => {
        if (valid && !remove.isPending) remove.mutate();
      }}
      footer={
        <>
          <Button onClick={props.onClose} data-testid="dialog-cancel">
            {t('confirm.cancel')}
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!valid}
            loading={remove.isPending}
            data-testid="tenant-delete-confirm"
          >
            {t('console.tenant.deleteConfirmButton')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label
          htmlFor={confirmId}
          className="flex flex-col gap-1.5 text-sm font-medium"
        >
          {t('console.tenant.deleteConfirm', { slug: props.tenant.slug })}
          <input
            id={confirmId}
            data-testid="tenant-delete-slug"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            maxLength={80}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label
          htmlFor={reasonId}
          className="flex flex-col gap-1.5 text-sm font-medium"
        >
          {t('console.reason')}
          <textarea
            id={reasonId}
            data-testid="tenant-delete-reason"
            required
            minLength={MIN_REASON}
            maxLength={500}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={textareaClass}
          />
        </label>
        <ErrorNote error={remove.error} />
      </div>
    </FormDialog>
  );
}
