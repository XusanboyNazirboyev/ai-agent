import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

/** A titled card of the details panel. */
export function Section(props: {
  title: string;
  icon?: IconName;
  testId?: string;
  /** Heading level; 3 under an h2 (default), 2 directly under the page h1. */
  level?: 2 | 3;
  children: ReactNode;
}): ReactNode {
  const Heading = props.level === 2 ? 'h2' : 'h3';
  return (
    <section
      data-testid={props.testId}
      className="rounded-xl border border-line bg-surface p-3 shadow-card"
    >
      <Heading className="mb-2 flex items-center gap-2 text-sm font-semibold">
        {props.icon ? (
          <span className="text-muted">
            <Icon name={props.icon} />
          </span>
        ) : null}
        {props.title}
      </Heading>
      <div className="flex flex-col gap-1.5 text-sm">{props.children}</div>
    </section>
  );
}
