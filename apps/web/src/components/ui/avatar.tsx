import type { ReactNode } from 'react';

const TONES = [
  'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
];

/** Up to two letters of an untrusted display name (code points, not HTML). */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/u).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toLocaleUpperCase() ?? '');
  return letters.join('') || '?';
}

function toneFor(seed: string): string {
  let hash = 0;
  for (const char of seed)
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return TONES[hash % TONES.length];
}

/** Decorative: the person's name is always shown as text next to it. */
export function Avatar(props: {
  name: string | null | undefined;
  size?: 'sm' | 'md';
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${
        props.size === 'sm' ? 'h-8 w-8 text-xs' : 'h-10 w-10 text-sm'
      } ${toneFor(props.name ?? '')}`}
    >
      {initials(props.name)}
    </span>
  );
}
