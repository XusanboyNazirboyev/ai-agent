'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import {
  MAX_IMPORT_BYTES,
  parseFaqFile,
  type ImportLimits,
  type ParsedImport,
} from '@/lib/faq-import';
import { Button } from './ui/button';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

/** Matches FAQ_IMPORT_BATCH on the server (the default request limit is 100 kB). */
const BATCH = 25;
const EXAMPLE =
  'question,answer,language\n"How long is the course?","Three months.",en';

interface Totals {
  created: number;
  updated: number;
  failed: number;
}

/** Choose a file, review what will happen, then send it in small batches. */
export function FaqImportDialog(props: {
  open: boolean;
  limits: ImportLimits;
  onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [consent, setConsent] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setParsed(null);
      setConsent(false);
      setProgress(null);
      setTotals(null);
      setFailure(null);
      dialog.showModal();
    }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  async function choose(file: File | undefined): Promise<void> {
    setTotals(null);
    setFailure(null);
    if (!file) return setParsed(null);
    if (file.size > MAX_IMPORT_BYTES)
      return setParsed({
        entries: [],
        problems: [{ row: 0, code: 'TOO_BIG' }],
      });
    setParsed(parseFaqFile(file.name, await file.text(), props.limits));
  }

  async function start(): Promise<void> {
    if (!parsed || !consent || progress !== null) return;
    const sum: Totals = { created: 0, updated: 0, failed: 0 };
    setFailure(null);
    setTotals(null);
    try {
      for (let at = 0; at < parsed.entries.length; at += BATCH) {
        setProgress(at);
        const batch = parsed.entries.slice(at, at + BATCH);
        const result = await api<{
          created: number;
          updated: number;
          failed: unknown[];
        }>('/api/v1/knowledge/faq/import', {
          method: 'POST',
          body: { entries: batch, confirmProviderMayReadText: true },
        });
        sum.created += result.created;
        sum.updated += result.updated;
        sum.failed += result.failed.length;
      }
      toast(t('toast.faqImported'));
    } catch (error) {
      setFailure(error);
    } finally {
      setProgress(null);
      setTotals(sum);
      void queryClient.invalidateQueries({ queryKey: ['faq'] });
    }
  }

  const busy = progress !== null;
  const problems = parsed?.problems ?? [];
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="faq-import-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) props.onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !busy) props.onClose();
      }}
      className="m-auto max-h-[92dvh] w-[min(94vw,36rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-lg font-semibold">
          {t('knowledge.importTitle')}
        </h2>
        <p className="text-sm text-muted">{t('knowledge.importHelp')}</p>
        <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs break-words whitespace-pre-wrap">
          {EXAMPLE}
        </pre>
        <p className="text-sm text-muted">{t('knowledge.importSame')}</p>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('knowledge.importFile')}
          <input
            type="file"
            data-testid="faq-import-file"
            accept=".csv,.tsv,.json,.txt,.md,text/csv,application/json,text/plain"
            disabled={busy}
            onChange={(event) => void choose(event.target.files?.[0])}
            className="w-full min-w-0 text-sm file:mr-3 file:min-h-10 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-sm file:font-medium file:text-fg"
          />
        </label>

        {parsed ? (
          <div
            className="flex flex-col gap-2 text-sm"
            data-testid="faq-import-summary"
          >
            {parsed.entries.length > 0 ? (
              <p className="flex items-center gap-2 font-medium">
                <Icon name="check" className="h-4 w-4 text-success-fg" />
                {t('knowledge.importReady', { count: parsed.entries.length })}
              </p>
            ) : (
              <p className="text-muted">{t('knowledge.importNothing')}</p>
            )}
            {problems.length > 0 ? (
              <div className="flex flex-col gap-1 rounded-lg bg-warning-soft p-3 text-warning-fg">
                <p className="font-medium">
                  {t('knowledge.importSkipped', {
                    count: problems.filter((p) => p.row > 0).length,
                  })}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {problems.slice(0, 5).map((problem) => (
                    <li key={`${problem.row}-${problem.code}`}>
                      {problem.row > 0
                        ? t('knowledge.importRow', {
                            row: problem.row,
                            reason: t(`importProblem.${problem.code}`),
                          })
                        : t('knowledge.importWhole', {
                            reason: t(`importProblem.${problem.code}`),
                          })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {parsed && parsed.entries.length > 0 ? (
          <label className="flex items-start gap-2.5 rounded-xl bg-surface-2 p-3 text-sm">
            <input
              type="checkbox"
              data-testid="faq-import-consent"
              checked={consent}
              disabled={busy}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            <span>{t('knowledge.consent')}</span>
          </label>
        ) : null}

        {busy && parsed ? (
          <p role="status" className="text-sm text-muted">
            {t('knowledge.importProgress', {
              done: Math.min(progress ?? 0, parsed.entries.length),
              total: parsed.entries.length,
            })}
          </p>
        ) : null}
        {totals ? (
          <p
            role="status"
            data-testid="faq-import-result"
            className="text-sm font-medium"
          >
            {t('knowledge.importResult', { ...totals })}
          </p>
        ) : null}
        {failure ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(failure))}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onClick={props.onClose}
            disabled={busy}
            data-testid="faq-import-close"
          >
            {t('knowledge.importClose')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!parsed || parsed.entries.length === 0 || !consent}
            data-testid="faq-import-start"
            onClick={() => void start()}
          >
            {t('knowledge.importStart')}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
