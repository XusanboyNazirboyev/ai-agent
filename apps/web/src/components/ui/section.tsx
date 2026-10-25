import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

/** A titled card of the details panel. */
export function Section(props: {
  title: string;
  icon?: IconName;
  testId?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      data-testid={props.testId}
      className="rounded-xl border border-line bg-surface p-3 shadow-card"
    >
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        {props.icon ? (
          <span className="text-muted">
            <Icon name={props.icon} />
          </span>
        ) : null}
        {props.title}
      </h3>
      <div className="flex flex-col gap-1.5 text-sm">{props.children}</div>
    </section>
  );
}
