'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button, type ButtonVariant } from './button';

/**
 * Modal confirmation on the native <dialog>: focus is trapped and returned,
 * Escape cancels, and the backdrop is not part of the content.
 */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: ButtonVariant;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onCancel();
      }}
      className="m-auto w-[min(92vw,26rem)] rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-lg font-semibold">
          {props.title}
        </h2>
        <p id={bodyId} className="text-sm text-muted">
          {props.body}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            autoFocus
            onClick={props.onCancel}
            data-testid="confirm-cancel"
          >
            {props.cancelLabel}
          </Button>
          <Button
            variant={props.tone ?? 'primary'}
            loading={props.busy}
            onClick={props.onConfirm}
            data-testid="confirm-accept"
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
