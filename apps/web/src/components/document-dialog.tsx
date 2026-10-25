'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { errorKey } from '@/lib/api';
import { Button } from './ui/button';
import { fieldClass, textareaClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Select } from './ui/select';

export interface DocumentDraft {
  title: string;
  text: string;
  language: string;
  topic: string;
  regulated: boolean;
}

const EMPTY: DocumentDraft = {
  title: '',
  text: '',
  language: '',
  topic: '',
  regulated: false,
};

/** Upload a text file or paste text; the text stays editable before saving. */
export function DocumentDialog(props: {
  open: boolean;
  limits: { text: number; title: number };
  busy: boolean;
  error: unknown;
  onSave: (draft: DocumentDraft) => void;
  onCancel: () => void;
}): ReactNode {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState<DocumentDraft>(EMPTY);
  const [consent, setConsent] = useState(false);
  const [fileProblem, setFileProblem] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setDraft(EMPTY);
      setConsent(false);
      setFileProblem(false);
      dialog.showModal();
    }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  async function choose(file: File | undefined): Promise<void> {
    setFileProblem(false);
    if (!file) return;
    // A byte count first: never read a huge file into memory.
    if (file.size > props.limits.text * 4) return setFileProblem(true);
    const text = (await file.text()).replace(/^\uFEFF/u, '');
    setDraft((current) => ({
      ...current,
      text,
      title:
        current.title ||
        file.name.replace(/\.[^.]+$/u, '').slice(0, props.limits.title),
    }));
  }

  const tooLong = draft.text.length > props.limits.text;
  const ready =
    consent &&
    !tooLong &&
    draft.title.trim().length >= 2 &&
    draft.text.trim().length > 0;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (ready && !props.busy) props.onSave(draft);
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="document-dialog"
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onCancel();
      }}
      className="m-auto max-h-[92dvh] w-[min(94vw,40rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-lg font-semibold">
          {t('documents.dialogTitle')}
        </h2>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('documents.file')}
          <input
            type="file"
            data-testid="document-file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            onChange={(event) => void choose(event.target.files?.[0])}
            className="w-full min-w-0 text-sm file:mr-3 file:min-h-10 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-sm file:font-medium file:text-fg"
          />
          <span className="text-xs font-normal text-muted">
            {t('documents.fileHint')}
          </span>
        </label>
        {fileProblem ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('documents.tooLong', { max: props.limits.text })}
          </p>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('documents.docTitle')}
          <input
            data-testid="document-title"
            required
            minLength={2}
            maxLength={props.limits.title}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className={fieldClass}
          />
          <span className="text-xs font-normal text-muted">
            {t('documents.replaceNote')}
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <span className="flex items-center justify-between gap-2">
            {t('documents.text')}
            <span
              className={`text-xs ${tooLong ? 'text-danger-fg' : 'text-muted'}`}
            >
              {t('knowledge.counter', {
                used: draft.text.length,
                max: props.limits.text,
              })}
            </span>
          </span>
          <textarea
            data-testid="document-text"
            required
            rows={8}
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            className={`${textareaClass} resize-y`}
          />
          {tooLong ? (
            <span className="text-xs font-normal text-danger-fg">
              {t('documents.tooLong', { max: props.limits.text })}
            </span>
          ) : null}
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('knowledge.language')}
            <Select
              value={draft.language}
              onChange={(e) => setDraft({ ...draft, language: e.target.value })}
            >
              <option value="">{t('knowledge.languageAny')}</option>
              {['uz', 'ru', 'en'].map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('documents.topic')}
            <input
              maxLength={100}
              pattern="[\p{L}\p{N} _\-]*"
              value={draft.topic}
              onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
              className={fieldClass}
            />
          </label>
        </div>
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.regulated}
            onChange={(e) =>
              setDraft({ ...draft, regulated: e.target.checked })
            }
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t('knowledge.regulated')}</span>
            <span className="text-muted">{t('knowledge.regulatedHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 rounded-xl bg-surface-2 p-3 text-sm">
          <input
            type="checkbox"
            data-testid="document-consent"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          />
          <span>{t('knowledge.consent')}</span>
        </label>
        {props.error ? (
          <p
            role="alert"
            data-testid="document-error"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(props.error))}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={props.onCancel} data-testid="document-cancel">
            {t('confirm.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={props.busy}
            disabled={!ready}
            data-testid="document-save"
          >
            {props.busy ? t('knowledge.saving') : t('knowledge.save')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
