'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

const STORAGE_PREFIX = 'tezda.section.';

function readOpen(key: string | undefined): boolean | null {
  if (!key) return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_PREFIX + key);
    return stored === '1' ? true : stored === '0' ? false : null;
  } catch {
    return null;
  }
}

/**
 * A titled card of the details panel. With `collapsible` it is an accordion
 * row (a native details element, so keyboard and screen readers work): the
 * title, a one-line `summary` that stays visible when it is closed, and a
 * chevron. An operator's choice is remembered per `storageKey`.
 */
export function Section(props: {
  title: string;
  icon?: IconName;
  testId?: string;
  /** Heading level; 3 under an h2 (default), 2 directly under the page h1. */
  level?: 2 | 3;
  collapsible?: boolean;
  /** Open when nothing was chosen before (default open). */
  defaultOpen?: boolean;
  /** Shown beside the title while the section is closed. */
  summary?: ReactNode;
  storageKey?: string;
  children: ReactNode;
}): ReactNode {
  const Heading = props.level === 2 ? 'h2' : 'h3';
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  useEffect(() => {
    const stored = readOpen(props.storageKey);
    if (stored !== null) setOpen(stored);
  }, [props.storageKey]);

  const title = (
    <Heading className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
      {props.icon ? (
        <span className="text-muted">
          <Icon name={props.icon} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
    </Heading>
  );

  if (!props.collapsible)
    return (
      <section
        data-testid={props.testId}
        className="rounded-xl border border-line bg-surface p-3 shadow-card"
      >
        <div className="mb-2 flex">{title}</div>
        <div className="flex flex-col gap-1.5 text-sm">{props.children}</div>
      </section>
    );

  return (
    <section
      data-testid={props.testId}
      className="rounded-xl border border-line bg-surface shadow-card"
    >
      <details
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          setOpen(next);
          if (props.storageKey)
            try {
              window.localStorage.setItem(
                STORAGE_PREFIX + props.storageKey,
                next ? '1' : '0',
              );
            } catch {
              // Not remembered; the choice still applies to this page view.
            }
        }}
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 select-none hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
          {title}
          {!open && props.summary ? (
            <span className="max-w-[40%] shrink-0 truncate text-xs text-muted">
              {props.summary}
            </span>
          ) : null}
          <Icon
            name="chevronRight"
            className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </summary>
        <div className="flex flex-col gap-1.5 px-3 pb-3 text-sm">
          {props.children}
        </div>
      </details>
    </section>
  );
}
