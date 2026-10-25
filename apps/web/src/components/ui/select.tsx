import type { ReactNode, SelectHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons';

// A native select (keyboard and mobile pickers stay native) inside a bordered
// flex row: [leading icon] [select] [chevron]. Nothing is positioned
// absolutely, so the icon, the label and the chevron can never overlap, and a
// browser that keeps its own arrow only shows it beside ours, not on top.
// `className` styles the row (width, margins). The focus ring is drawn on the
// row, and only for keyboard focus.
export function Select({
  icon,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { icon?: IconName }): ReactNode {
  return (
    <span
      className={`flex min-h-10 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-fg has-[:disabled]:opacity-60 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${className}`}
    >
      {icon ? (
        <Icon name={icon} className="h-4 w-4 shrink-0 text-muted" />
      ) : null}
      <select
        className="min-w-0 flex-1 bg-transparent py-2 text-sm text-fg"
        {...rest}
      >
        {children}
      </select>
      <Icon name="chevronDown" className="h-4 w-4 shrink-0 text-muted" />
    </span>
  );
}
