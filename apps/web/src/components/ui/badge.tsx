import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-primary-soft text-primary-fg',
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  danger: 'bg-danger-soft text-danger-fg',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-muted',
  accent: 'bg-primary-fg',
  success: 'bg-success-fg',
  warning: 'bg-warning-fg',
  danger: 'bg-danger-fg',
};

export function Badge(props: {
  tone?: Tone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const tone = props.tone ?? 'neutral';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]} ${props.className ?? ''}`}
    >
      {props.dot ? (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`}
        />
      ) : null}
      {props.children}
    </span>
  );
}
