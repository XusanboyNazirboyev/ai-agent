import type { ReactNode } from 'react';

/** Loading placeholder; the announced text is provided by the caller. */
export function SkeletonRows(props: { rows?: number }): ReactNode {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {Array.from({ length: props.rows ?? 4 }, (_, index) => (
        <div
          key={index}
          className="flex animate-pulse items-center gap-3 border-b border-line px-4 py-3"
        >
          <span className="h-10 w-10 shrink-0 rounded-full bg-surface-2" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3 w-2/5 rounded bg-surface-2" />
            <span className="h-3 w-3/5 rounded bg-surface-2" />
          </span>
        </div>
      ))}
    </div>
  );
}
