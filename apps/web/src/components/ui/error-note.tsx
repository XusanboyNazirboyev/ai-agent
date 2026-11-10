'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { errorKey } from '@/lib/api';
import { Icon, Spinner, type IconName } from './icons';

/** An API failure as a translated alert (the API's answer is the truth). */
export function ErrorNote(props: {
  error: unknown;
  testId?: string;
}): ReactNode {
  const { t } = useI18n();
  if (!props.error) return null;
  return (
    <p
      role="alert"
      data-testid={props.testId}
      className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
    >
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      {t(errorKey(props.error))}
    </p>
  );
}

/** Loading, error and empty states of a list or page query. */
export function QueryState(props: {
  pending: boolean;
  error: unknown;
  onRetry: () => void;
}): ReactNode {
  const { t } = useI18n();
  if (props.pending)
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <Spinner />
        {t('app.loading')}
      </p>
    );
  if (!props.error) return null;
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorNote error={props.error} />
      <button
        type="button"
        onClick={props.onRetry}
        className="min-h-9 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
      >
        {t('app.retry')}
      </button>
    </div>
  );
}

/** Nothing to list yet. */
export function EmptyState(props: { icon: IconName; text: string }): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center text-muted">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2">
        <Icon name={props.icon} className="h-6 w-6" />
      </span>
      <p>{props.text}</p>
    </div>
  );
}
