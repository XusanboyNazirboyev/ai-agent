import type { ReactNode } from 'react';

export function Card(props: {
  name: string;
  badge: ReactNode;
  testId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      data-testid={props.testId}
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 font-semibold break-words">{props.name}</h2>
        {props.badge}
      </div>
      {props.children}
    </section>
  );
}
