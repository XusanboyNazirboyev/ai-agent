'use client';

import {
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './icons';

// A native select (keyboard and mobile pickers stay native) inside a bordered
// flex row: [leading icon] [select] [chevron]. Nothing is positioned
// absolutely, so the icon, the label and the chevron can never overlap, and a
// browser that keeps its own arrow only shows it beside ours, not on top.
// `className` styles the row (width, margins). The focus ring is drawn on the
// row, and only for keyboard focus: Chrome treats a select opened with the
// mouse as keyboard-focused, so a mouse press hides the ring until the next
// key or until focus leaves (owner screenshot 2026-11-16).
// The icon and the chevron sit beside the select, so a click on them (or on
// the row's padding) opens the picker with showPicker(), or at least focuses
// the select where a browser has no showPicker (owner report 2026-11-16).
export function Select({
  icon,
  compact = false,
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
}): ReactNode {
  const [byPointer, setByPointer] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  function openFromRow(event: MouseEvent<HTMLSpanElement>): void {
    const select = selectRef.current;
    if (!select || select.disabled || event.target === select) return;
    setByPointer(true);
    select.focus();
    try {
      select.showPicker();
    } catch {
      // No showPicker here, or the browser refused it: focus is enough.
    }
  }
  const ring = byPointer
    ? ''
    : 'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring';
  return (
    <span
      data-pointer={byPointer || undefined}
      onClick={openFromRow}
      className={`flex ${compact ? 'min-h-9' : 'min-h-10'} min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-fg has-[:disabled]:opacity-60 ${ring} ${className}`}
    >
      {icon ? (
        <Icon name={icon} className="h-4 w-4 shrink-0 text-muted" />
      ) : null}
      <select
        ref={selectRef}
        className={`min-w-0 flex-1 bg-transparent ${compact ? 'py-1.5' : 'py-2'} tz-select text-sm text-fg`}
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
      <Icon name="chevronDown" className="h-4 w-4 shrink-0 text-muted" />
    </span>
  );
}
