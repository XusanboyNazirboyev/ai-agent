'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { parseAmount, readLastCurrency } from '@/lib/currencies';
import {
  detectColumns,
  IMPORT_FIELDS,
  parseCsv,
  type ImportField,
  type ParsedCsv,
} from '@/lib/csv-parse';
import { LEAD_AMOUNT_ENABLED } from '@/lib/lead-fields';
import type { BoardStageView } from '@/lib/types';
import { stageLabel } from './lead-board-utils';
import { Button } from './ui/button';
import { FormDialog } from './ui/form-dialog';
import { Select } from './ui/select';

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/** Rows per request (the API takes at most 200). */
export const IMPORT_CHUNK = 200;
const PREVIEW_ROWS = 5;

type Mapping = Record<ImportField, number>;
interface Skipped {
  /** Row number as in the file (the header is row 1). */
  row: number;
  code: string;
}
interface ImportResponse {
  created: number;
  skipped: Array<{ row: number; code: string }>;
}
type Phase =
  | { kind: 'pick' }
  | { kind: 'ready' }
  | { kind: 'importing'; done: number }
  | { kind: 'done'; created: number; skipped: Skipped[] };

const REASON_CODES = ['INVALID_VALUE', 'DUPLICATE'];

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * Imports leads from a CSV file (ADR 077): the browser parses the file, the
 * user checks the column mapping and the stage, the API validates every row
 * with the manual-lead rules and reports what it skipped.
 */
export function LeadsImportDialog(props: {
  open: boolean;
  pipelineId: string;
  stages: BoardStageView[];
  onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fileId = useId();
  const progressId = useId();
  const openStages = props.stages.filter((s) => s.kind === 'OPEN');
  const fields = IMPORT_FIELDS.filter(
    (f) => LEAD_AMOUNT_ENABLED || (f !== 'amount' && f !== 'currency'),
  );

  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [stageId, setStageId] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setCsv(null);
    setMapping(null);
    setFileError(null);
    setFailure(null);
    setPhase({ kind: 'pick' });
  }, [props.open]);

  const firstOpenId = openStages[0]?.id ?? '';
  useEffect(() => {
    if (props.open && firstOpenId !== '')
      setStageId((current) =>
        openStages.some((s) => s.id === current) ? current : firstOpenId,
      );
    // openStages derives from props.stages.
  }, [props.open, firstOpenId]);

  async function onFile(file: File | undefined): Promise<void> {
    setFileError(null);
    setFailure(null);
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setFileError('leadsImport.fileTooLarge');
      return;
    }
    let parsed: ParsedCsv;
    try {
      parsed = parseCsv(await readText(file));
    } catch {
      setFileError('leadsImport.fileUnreadable');
      return;
    }
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      setFileError('leadsImport.noRows');
      setCsv(null);
      setPhase({ kind: 'pick' });
      return;
    }
    setCsv(parsed);
    setMapping(detectColumns(parsed.headers));
    setPhase({ kind: 'ready' });
  }

  const payload = useMemo(() => {
    if (!csv || !mapping) return [];
    const cell = (row: string[], field: ImportField): string =>
      mapping[field] >= 0 ? (row[mapping[field]] ?? '').trim() : '';
    const defaultCurrency = readLastCurrency() ?? 'UZS';
    return csv.rows.map((row) => {
      const out: Record<string, string> = { name: cell(row, 'name') };
      for (const f of ['phone', 'source', 'note'] as const) {
        const v = cell(row, f);
        if (v) out[f] = v;
      }
      if (LEAD_AMOUNT_ENABLED) {
        const amount = cell(row, 'amount').replace(/\s/gu, '');
        if (amount) {
          out.amount = parseAmount(amount) ?? amount;
          out.currency = cell(row, 'currency').toUpperCase() || defaultCurrency;
        }
      }
      return out;
    });
  }, [csv, mapping]);

  const importing = phase.kind === 'importing';
  const canImport =
    phase.kind === 'ready' &&
    mapping !== null &&
    mapping.name >= 0 &&
    stageId !== '' &&
    payload.length > 0;

  async function run(): Promise<void> {
    if (!canImport) return;
    setFailure(null);
    let created = 0;
    const skipped: Skipped[] = [];
    try {
      for (let at = 0; at < payload.length; at += IMPORT_CHUNK) {
        setPhase({ kind: 'importing', done: at });
        const res = await api<ImportResponse>('/api/v1/leads/import', {
          method: 'POST',
          body: {
            pipelineId: props.pipelineId,
            stageId,
            rows: payload.slice(at, at + IMPORT_CHUNK),
          },
        });
        created += res.created;
        // The file line of the row, blank lines and the header counted.
        for (const s of res.skipped)
          skipped.push({
            row: csv?.lines[at + s.row] ?? at + s.row + 2,
            code: s.code,
          });
      }
      setPhase({ kind: 'done', created, skipped });
    } catch (error) {
      setFailure(errorKey(error));
      // What was already created stays; show it with the error.
      setPhase(
        created > 0 ? { kind: 'done', created, skipped } : { kind: 'ready' },
      );
    } finally {
      void qc.invalidateQueries({ queryKey: ['board'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['pipelines'] });
    }
  }

  const reason = (code: string): string =>
    t(
      REASON_CODES.includes(code)
        ? `leadsImport.reason.${code}`
        : 'leadsImport.reason.OTHER',
    );

  const done = phase.kind === 'done' ? phase : null;

  return (
    <FormDialog
      open={props.open}
      title={t('leadsImport.title')}
      description={t('leadsImport.description')}
      testId="leads-import-dialog"
      onClose={importing ? () => undefined : props.onClose}
      onSubmit={() => {
        if (canImport) void run();
      }}
      footer={
        done ? (
          <Button variant="primary" onClick={props.onClose}>
            {t('leadsImport.close')}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              onClick={props.onClose}
              disabled={importing}
            >
              {t('app.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={importing}
              disabled={!canImport}
              data-testid="leads-import-submit"
            >
              {t('leadsImport.submit', { count: payload.length })}
            </Button>
          </>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {done ? (
          <div
            className="flex flex-col gap-2"
            data-testid="leads-import-result"
          >
            <p role="status" className="text-sm font-medium">
              {t('leadsImport.done', { count: done.created })}
            </p>
            {done.skipped.length > 0 ? (
              <>
                <p className="text-sm text-muted">
                  {t('leadsImport.skipped', { count: done.skipped.length })}
                </p>
                <ul
                  className="max-h-48 overflow-y-auto rounded-lg border border-line p-2 text-sm"
                  data-testid="leads-import-skipped"
                >
                  {done.skipped.map((s) => (
                    <li key={`${s.row}-${s.code}`}>
                      {t('leadsImport.skippedRow', {
                        row: s.row,
                        reason: reason(s.code),
                      })}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1 text-sm font-medium">
              <label htmlFor={fileId}>{t('leadsImport.file')}</label>
              <input
                id={fileId}
                type="file"
                accept=".csv,text/csv"
                disabled={importing}
                onChange={(e) => void onFile(e.target.files?.[0])}
                className="text-sm font-normal file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-sm"
                data-testid="leads-import-file"
              />
              <span className="text-xs font-normal text-muted">
                {t('leadsImport.fileHint')}
              </span>
            </div>
            {fileError ? (
              <p role="alert" className="text-sm text-danger-fg">
                {t(fileError)}
              </p>
            ) : null}
            {csv && mapping ? (
              <>
                <fieldset
                  className="grid min-w-0 gap-2 sm:grid-cols-2"
                  disabled={importing}
                >
                  <legend className="mb-1 text-sm font-medium">
                    {t('leadsImport.columns')}
                  </legend>
                  {fields.map((field) => (
                    <label
                      key={field}
                      className="flex min-w-0 flex-col gap-1 text-sm"
                    >
                      <span>
                        {t(`leadsImport.field.${field}`)}
                        {field === 'name' ? ' *' : ''}
                      </span>
                      <Select
                        field
                        value={String(mapping[field])}
                        onChange={(e) =>
                          setMapping({
                            ...mapping,
                            [field]: Number(e.target.value),
                          })
                        }
                        className="w-full"
                        aria-invalid={field === 'name' && mapping.name < 0}
                        data-testid={`leads-import-map-${field}`}
                      >
                        <option value="-1">{t('leadsImport.notMapped')}</option>
                        {csv.headers.map((h, i) => (
                          <option key={i} value={String(i)}>
                            {h || `#${i + 1}`}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ))}
                </fieldset>
                {mapping.name < 0 ? (
                  <p role="alert" className="text-sm text-danger-fg">
                    {t('leadsImport.nameRequired')}
                  </p>
                ) : null}
                <label className="flex flex-col gap-1 text-sm font-medium">
                  {t('leadsImport.stage')}
                  <Select
                    field
                    value={stageId}
                    disabled={importing}
                    onChange={(e) => setStageId(e.target.value)}
                    className="w-full"
                    data-testid="leads-import-stage"
                  >
                    {openStages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {stageLabel(s, t)}
                      </option>
                    ))}
                  </Select>
                </label>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm font-medium">
                    {t('leadsImport.preview')}
                  </p>
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table
                      className="w-full text-left text-xs"
                      data-testid="leads-import-preview"
                    >
                      <thead className="text-muted">
                        <tr>
                          {fields
                            .filter((f) => mapping[f] >= 0)
                            .map((f) => (
                              <th key={f} className="px-2 py-1 font-medium">
                                {t(`leadsImport.field.${f}`)}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {payload.slice(0, PREVIEW_ROWS).map((row, i) => (
                          <tr key={i} className="border-t border-line">
                            {fields
                              .filter((f) => mapping[f] >= 0)
                              .map((f) => (
                                <td
                                  key={f}
                                  className="max-w-40 truncate px-2 py-1"
                                >
                                  {row[f] ?? ''}
                                </td>
                              ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : null}
            <p
              id={progressId}
              role="status"
              aria-live="polite"
              className="text-sm text-muted"
              data-testid="leads-import-progress"
            >
              {phase.kind === 'importing'
                ? t('leadsImport.progress', {
                    done: Math.min(phase.done + IMPORT_CHUNK, payload.length),
                    total: payload.length,
                  })
                : ''}
            </p>
            {failure ? (
              <p role="alert" className="text-sm text-danger-fg">
                {t(failure)}
              </p>
            ) : null}
          </>
        )}
        {done && failure ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(failure)}
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}
