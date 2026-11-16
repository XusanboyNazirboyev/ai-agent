'use client';

import { useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons';

// A native select (keyboard and mobile pickers stay native) inside a bordered
// flex row: [leading icon] [select] [chevron]. The select's box reaches under
// the icon and the chevron (negative margins, matching padding, so its text
// stays beside them), and both are drawn over it without catching the
// pointer: a click anywhere in the row lands on the select itself and opens
// it natively in every browser. showPicker() from the chevron did not open it
// in every browser (owner report 2026-11-16, second time).
// `className` styles the row (width, margins). The focus ring is drawn on the
// row, and only for keyboard focus: Chrome treats a select opened with the
// mouse as keyboard-focused, so a mouse press hides the ring until the next
// key or until focus leaves (owner screenshot 2026-11-16).
export function Select({
  icon,
  compact = false,
  field = false,
  className = '',
  children,
  onPointerDown,
  onKeyDown,
  onBlur,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  icon?: IconName;
  /** As tall as a small button, for toolbars. */
  compact?: boolean;
  /** As tall as a text field (fieldClass), 16px text: forms, no iOS zoom. */
  field?: boolean;
}): ReactNode {
  const [byPointer, setByPointer] = useState(false);
  const ring = byPointer
    ? ''
    : 'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring';
  // Row padding 12px, icon 16px, gap 8px: the select starts at the row's
  // edge and its text where it would stand beside the icon (36px).
  const reach = `${icon ? '-ml-9 pl-9' : '-ml-3 pl-3'} -mr-9 pr-9`;
  return (
    <span
      data-pointer={byPointer || undefined}
      className={`flex ${compact ? 'min-h-9' : field ? 'min-h-11' : 'min-h-10'} min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-fg has-[:disabled]:opacity-60 ${ring} ${className}`}
    >
      {icon ? (
        <Icon
          name={icon}
          className="pointer-events-none h-4 w-4 shrink-0 text-muted"
        />
      ) : null}
      <select
        className={`min-w-0 flex-1 self-stretch bg-transparent ${reach} ${compact ? 'py-1.5' : 'py-2'} tz-select cursor-pointer ${field ? 'text-base' : 'text-sm'} text-fg disabled:cursor-not-allowed`}
        onPointerDown={(event) => {
          setByPointer(true);
          onPointerDown?.(event);
        }}
        onKeyDown={(event) => {
          // Tab leaves (blur resets) and Escape only closes the picker; any
          // other key means the keyboard is in use here.
          if (event.key !== 'Tab' && event.key !== 'Escape')
            setByPointer(false);
          onKeyDown?.(event);
        }}
        onBlur={(event) => {
          setByPointer(false);
          onBlur?.(event);
        }}
        {...rest}
      >
        {children}
      </select>
      <Icon
        name="chevronDown"
        className="pointer-events-none h-4 w-4 shrink-0 text-muted"
      />
    </span>
  );
}
