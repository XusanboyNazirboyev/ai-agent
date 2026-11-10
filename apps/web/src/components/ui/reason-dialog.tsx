'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Button, type ButtonVariant } from './button';
import { ErrorNote } from './error-note';
import { textareaClass } from './fields';
import { FormDialog } from './form-dialog';

/** Minimum reason length the API accepts (ADR 047 audit trail). */
export const MIN_REASON = 3;

/**
 * Confirmation of a consequential console action that needs a written
 * reason (suspend, archive, cancel). The reason goes to the audit trail.
 */
export function ReasonDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  tone?: ButtonVariant;
  busy: boolean;
  error: unknown;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const fieldId = useId();
  useEffect(() => {
    if (!props.open) setReason('');
  }, [props.open]);
  const valid = reason.trim().length >= MIN_REASON;
  return (
    <FormDialog
      open={props.open}
      title={props.title}
      description={props.body}
      testId="reason-dialog"
      onClose={props.onCancel}
      onSubmit={() => {
        if (valid && !props.busy) props.onConfirm(reason.trim());
      }}
      footer={
        <>
          <Button onClick={props.onCancel} data-testid="reason-cancel">
            {t('confirm.cancel')}
          </Button>
          <Button
            type="submit"
            variant={props.tone ?? 'primary'}
            loading={props.busy}
            disabled={!valid}
            data-testid="reason-confirm"
          >
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <label
        htmlFor={fieldId}
        className="flex flex-col gap-1.5 text-sm font-medium"
      >
        {t('console.reason')}
        <textarea
          id={fieldId}
          data-testid="reason-input"
          required
          minLength={MIN_REASON}
          maxLength={500}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={textareaClass}
        />
        <span className="text-xs font-normal text-muted">
          {t('console.reasonHint')}
        </span>
      </label>
      <ErrorNote error={props.error} testId="reason-error" />
    </FormDialog>
  );
}
