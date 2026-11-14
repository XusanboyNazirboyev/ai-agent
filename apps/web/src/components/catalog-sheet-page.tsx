'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { CURRENCIES } from '@/lib/currencies';
import {
  SHEET_FIELDS,
  missingSheetFields,
  sheetConfigQuery,
  withMapping,
  type SheetField,
  type SheetMapping,
  type SheetPreview,
  type SheetStatus,
  type SheetUploadResult,
} from '@/lib/sheet-catalog';
import { useShell } from './app-shell';
import { SettingsSubPage } from './settings-section-nav';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const REQUIRED_FIELDS: readonly SheetField[] = ['price'];

interface PickedFile {
  name: string;
  text: string;
}

function canManage(role: string): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function CatalogSheetPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const fileId = useId();
  const manage = canManage(operator.role);

  const [file, setFile] = useState<PickedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  /** `null`: the server suggests the columns; set once the admin changes one. */
  const [mapping, setMapping] = useState<SheetMapping | null>(null);
  const [currency, setCurrency] = useState('');
  const [days, setDays] = useState(3);
  const [bound, setBound] = useState<SheetUploadResult | null>(null);

  const status = useQuery({
    queryKey: ['sheet-status'],
    queryFn: () => api<SheetStatus>('/api/v1/catalog/sheet'),
    enabled: manage,
  });

  const config = sheetConfigQuery({
    mapping: mapping ?? undefined,
    defaultCurrency: currency,
    freshnessDays: days,
  });
  const preview = useQuery({
    queryKey: ['sheet-preview', file?.name, file?.text.length, config],
    enabled: manage && file !== null,
    retry: false,
    queryFn: () =>
      api<SheetPreview>(
        `/api/v1/catalog/sheet/preview?config=${encodeURIComponent(config)}`,
        {
          method: 'POST',
          rawBody: file!.text,
          contentType: 'text/csv',
        },
      ),
  });

  // The columns the server suggested are the starting point of the form.
  const shown: SheetMapping = mapping ?? preview.data?.mapping ?? {};
  useEffect(() => {
    setMapping(null);
  }, [file?.name, file?.text.length]);

  const upload = useMutation({
    mutationFn: () =>
      api<SheetUploadResult>(
        `/api/v1/catalog/sheet?config=${encodeURIComponent(config)}&filename=${encodeURIComponent(file?.name ?? '')}`,
        { method: 'POST', rawBody: file!.text, contentType: 'text/csv' },
      ),
    onSuccess: (result) => {
      toast(t('sheet.saved'));
      setFile(null);
      setMapping(null);
      void qc.invalidateQueries({ queryKey: ['sheet-status'] });
      void qc.invalidateQueries({ queryKey: ['connector-roles'] });
      setBound(result);
    },
  });
  async function pick(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const picked = event.target.files?.[0];
    event.target.value = '';
    setBound(null);
    setFileError(null);
    if (!picked) return;
    if (picked.size > MAX_FILE_BYTES) {
      setFileError(t('errors.SHEET_TOO_LARGE'));
      return;
    }
    try {
      setFile({ name: picked.name, text: await picked.text() });
    } catch {
      setFileError(t('sheet.readFailed'));
    }
  }

  if (!manage)
    return (
      <SettingsSubPage active="catalog">
        <p className="p-4 text-sm text-muted">{t('settings.readOnly')}</p>
      </SettingsSubPage>
    );

  const data = preview.data;
  const missing = missingSheetFields(shown);
  const canSave = !!data && missing.length === 0 && data.accepted > 0;
  const date = (iso: string): string => new Date(iso).toLocaleDateString();

  return (
    <SettingsSubPage active="catalog">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('settings.section.catalog')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">{t('sheet.title')}</h2>
            <p className="text-sm text-muted">{t('sheet.intro')}</p>
          </div>

          <section
            aria-label={t('sheet.status.title')}
            data-testid="sheet-status"
            className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4"
          >
            {status.isPending ? <SkeletonRows rows={1} /> : null}
            {status.data && !status.data.uploaded ? (
              <p className="text-sm text-muted">{t('sheet.status.none')}</p>
            ) : null}
            {status.data?.uploaded ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={status.data.stale ? 'warning' : 'success'}>
                    {status.data.stale
                      ? t('sheet.stale.badge')
                      : t('sheet.fresh.badge')}
                  </Badge>
                  <span className="text-sm">
                    {t('sheet.status.updated', {
                      date: date(status.data.uploadedAt!),
                      accepted: status.data.acceptedCount ?? 0,
                      rejected: status.data.rejectedCount ?? 0,
                    })}
                  </span>
                </div>
                <p className="text-sm text-muted">
                  {status.data.stale
                    ? t('sheet.stale.body', {
                        days: status.data.freshnessDays ?? 3,
                      })
                    : t('sheet.fresh.body', {
                        date: date(status.data.validUntil!),
                      })}
                </p>
              </>
            ) : null}
            {bound ? (
              <p className="text-sm" data-testid="sheet-bound">
                {bound.catalogBound
                  ? t('sheet.bound')
                  : t('sheet.boundOther', { name: bound.boundTo ?? '' })}
              </p>
            ) : null}
          </section>

          <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
            <label htmlFor={fileId} className="text-sm font-medium">
              {file ? t('sheet.chooseAnother') : t('sheet.choose')}
            </label>
            <input
              id={fileId}
              type="file"
              accept=".csv,text/csv"
              data-testid="sheet-file"
              onChange={(event) => void pick(event)}
              className="text-sm"
            />
            <p className="text-xs text-muted">{t('sheet.chooseHint')}</p>
            {fileError ? (
              <p role="alert" className="text-sm text-danger-fg">
                {fileError}
              </p>
            ) : null}
          </section>

          {file && preview.isPending ? <SkeletonRows rows={3} /> : null}
          {preview.isError ? (
            <p
              role="alert"
              data-testid="sheet-error"
              className="text-sm text-danger-fg"
            >
              {t(errorKey(preview.error))}
            </p>
          ) : null}

          {file && data ? (
            <>
              <section
                aria-label={t('sheet.columns.title')}
                data-testid="sheet-columns"
                className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
              >
                <div className="flex flex-col gap-1">
                  <h3 className="font-semibold">{t('sheet.columns.title')}</h3>
                  <p className="text-sm text-muted">
                    {t('sheet.columns.hint')}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {SHEET_FIELDS.map((field) => (
                    <label
                      key={field}
                      className="flex min-w-0 flex-col gap-1 text-sm font-medium"
                    >
                      <span>
                        {t(`sheet.field.${field}`)}
                        {REQUIRED_FIELDS.includes(field) ? (
                          <span className="text-danger-fg"> *</span>
                        ) : null}
                      </span>
                      <select
                        value={shown[field] ?? ''}
                        onChange={(event) =>
                          setMapping(
                            withMapping(
                              shown,
                              field,
                              event.target.value === ''
                                ? null
                                : Number(event.target.value),
                            ),
                          )
                        }
                        data-testid={`sheet-map-${field}`}
                        className={fieldClass}
                      >
                        <option value="">{t('sheet.notUsed')}</option>
                        {data.header.map((name, index) => (
                          <option key={index} value={index}>
                            {name || t('sheet.column', { n: index + 1 })}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="flex min-w-0 flex-wrap items-end gap-3">
                  <label className="flex min-w-0 basis-48 flex-col gap-1 text-sm font-medium">
                    {t('sheet.options.currency')}
                    <select
                      value={currency}
                      onChange={(event) => setCurrency(event.target.value)}
                      data-testid="sheet-currency"
                      className={fieldClass}
                    >
                      <option value="">{t('sheet.notUsed')}</option>
                      {CURRENCIES.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex min-w-0 basis-48 flex-col gap-1 text-sm font-medium">
                    {t('sheet.options.days')}
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={days}
                      onChange={(event) =>
                        setDays(
                          Math.min(
                            30,
                            Math.max(1, Number(event.target.value) || 1),
                          ),
                        )
                      }
                      data-testid="sheet-days"
                      className={fieldClass}
                    />
                  </label>
                </div>
                {missing.length > 0 ? (
                  <p
                    role="alert"
                    data-testid="sheet-missing"
                    className="text-sm text-danger-fg"
                  >
                    {t('sheet.missing', {
                      fields: missing
                        .map((field) => t(`sheet.field.${field}`))
                        .join(', '),
                    })}
                  </p>
                ) : null}
              </section>

              <section
                aria-label={t('sheet.preview.title')}
                data-testid="sheet-preview"
                className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
              >
                <h3 className="font-semibold">{t('sheet.preview.title')}</h3>
                <p className="text-sm" data-testid="sheet-counts">
                  {t('sheet.preview.counts', {
                    accepted: data.accepted,
                    rejected: data.rejected,
                  })}
                </p>
                {data.sample.length > 0 ? (
                  <div
                    role="region"
                    tabIndex={0}
                    aria-label={t('sheet.preview.table')}
                    className="overflow-x-auto"
                  >
                    <table className="w-full min-w-[28rem] text-left text-sm">
                      <thead className="text-xs text-muted">
                        <tr>
                          <th className="py-1 pr-3">{t('sheet.col.line')}</th>
                          <th className="py-1 pr-3">{t('sheet.col.name')}</th>
                          <th className="py-1 pr-3">{t('sheet.col.price')}</th>
                          <th className="py-1 pr-3">{t('sheet.col.date')}</th>
                          <th className="py-1">{t('sheet.col.seats')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.sample.map((row) => (
                          <tr
                            key={row.line}
                            data-testid="sheet-sample-row"
                            className="border-t border-line"
                          >
                            <td className="py-1 pr-3 text-muted">{row.line}</td>
                            <td className="py-1 pr-3">{row.title}</td>
                            <td className="py-1 pr-3">
                              {row.price} {row.currency}
                            </td>
                            <td className="py-1 pr-3">
                              {row.departureDate ?? '—'}
                            </td>
                            <td className="py-1">
                              {t(`sheet.avail.${row.availability}`)}
                              {row.seatsLeft !== null
                                ? ` (${row.seatsLeft})`
                                : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {data.errors.length > 0 ? (
                  <div
                    className="flex flex-col gap-1"
                    data-testid="sheet-skipped"
                  >
                    <h4 className="text-sm font-medium">
                      {t('sheet.skipped.title')}
                    </h4>
                    <ul className="flex flex-col gap-1 text-sm text-danger-fg">
                      {data.errors.map((error, index) => (
                        <li
                          key={`${error.line}-${index}`}
                          data-testid="sheet-skipped-row"
                        >
                          {t('sheet.skipped.row', {
                            line: error.line,
                            reason: t(`sheet.rowError.${error.code}`),
                          })}
                        </li>
                      ))}
                    </ul>
                    {data.errorsTruncated ? (
                      <p className="text-xs text-muted">
                        {t('sheet.skipped.more')}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  loading={upload.isPending}
                  disabled={!canSave}
                  onClick={() => upload.mutate()}
                  data-testid="sheet-save"
                >
                  <Icon name="check" />
                  {t('sheet.save')}
                </Button>
                {upload.isError ? (
                  <p
                    role="alert"
                    data-testid="sheet-save-error"
                    className="text-sm text-danger-fg"
                  >
                    {t(errorKey(upload.error))}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </SettingsSubPage>
  );
}
