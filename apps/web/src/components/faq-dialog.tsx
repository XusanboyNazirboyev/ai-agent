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
import type { FaqItem } from '@/lib/types';
import { Button } from './ui/button';
import { fieldClass, textareaClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Select } from './ui/select';

export interface FaqDraft {
  question: string;
  answer: string;
  language: string;
  regulated: boolean;
}

/** Add or edit one question. A native dialog: focus is trapped and Escape cancels. */
export function FaqDialog(props: {
  open: boolean;
  item: FaqItem | null;
  limits: { question: number; answer: number };
  busy: boolean;
  error: unknown;
  onSave: (draft: FaqDraft) => void;
  onCancel: () => void;
}): ReactNode {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState<FaqDraft>({
    question: '',
    answer: '',
    language: '',
    regulated: false,
  });
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setDraft({
        question: props.item?.question ?? '',
        answer: props.item?.answer ?? '',
        language: props.item?.language ?? '',
        regulated: props.item?.regulated ?? false,
      });
      setConsent(false);
      dialog.showModal();
    }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open, props.item]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!consent || props.busy) return;
    props.onSave(draft);
  }

  const counter = (used: number, max: number): ReactNode => (
    <span className={`text-xs ${used > max ? 'text-danger-fg' : 'text-muted'}`}>
      {t('knowledge.counter', { used, max })}
    </span>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="faq-dialog"
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onCancel();
      }}
      className="m-auto max-h-[92dvh] w-[min(94vw,36rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-lg font-semibold">
          {props.item ? t('knowledge.dialogEdit') : t('knowledge.dialogAdd')}
        </h2>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <span className="flex items-center justify-between gap-2">
            {t('knowledge.question')}
            {counter(draft.question.length, props.limits.question)}
          </span>
          <input
            data-testid="faq-question"
            required
            minLength={3}
            maxLength={props.limits.question}
            value={draft.question}
            onChange={(e) => setDraft({ ...draft, question: e.target.value })}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <span className="flex items-center justify-between gap-2">
            {t('knowledge.answer')}
            {counter(draft.answer.length, props.limits.answer)}
          </span>
          <textarea
            data-testid="faq-answer"
            required
            maxLength={props.limits.answer}
            rows={5}
            value={draft.answer}
            onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
            className={`${textareaClass} resize-y`}
          />
        </label>
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
            data-testid="faq-consent"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          />
          <span>{t('knowledge.consent')}</span>
        </label>
        {props.error ? (
          <p
            role="alert"
            data-testid="faq-error"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(props.error))}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={props.onCancel} data-testid="faq-cancel">
            {t('confirm.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={props.busy}
            disabled={!consent}
            data-testid="faq-save"
          >
            {props.busy ? t('knowledge.saving') : t('knowledge.save')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
