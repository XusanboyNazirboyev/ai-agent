'use client';

import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type ReactNode,
} from 'react';

/**
 * A modal form on the native dialog element (focus trapped, Escape cancels,
 * focus returns to the opener on close). The body is a form; `footer` holds
 * its buttons, a submit button submits it.
 */
export function FormDialog(props: {
  open: boolean;
  title: string;
  description?: string;
  testId: string;
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
  footer: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    props.onSubmit?.();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descriptionId : undefined}
      data-testid={props.testId}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onClose();
      }}
      className="m-auto max-h-[92dvh] w-[min(94vw,32rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-lg font-semibold">
            {props.title}
          </h2>
          {props.description ? (
            <p id={descriptionId} className="text-sm text-muted">
              {props.description}
            </p>
          ) : null}
        </div>
        {props.children}
        <div className="flex flex-wrap justify-end gap-2">{props.footer}</div>
      </form>
    </dialog>
  );
}
