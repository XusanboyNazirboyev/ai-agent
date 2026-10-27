import type { ReactNode, SelectHTMLAttributes } from 'react';
import { selectClass } from './fields';
import { Icon, type IconName } from './icons';

// A native select (keyboard and mobile pickers stay native) with our own
// chevron and an optional leading icon. `className` styles the wrapper.
export function Select({
  icon,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { icon?: IconName }): ReactNode {
  return (
    <span className={`relative flex min-w-0 items-center ${className}`}>
      {icon ? (
        <span className="pointer-events-none absolute left-3 text-muted">
          <Icon name={icon} />
        </span>
      ) : null}
      <select className={`${selectClass} ${icon ? 'pl-9' : 'pl-3'}`} {...rest}>
        {children}
      </select>
      <span className="pointer-events-none absolute right-2.5 text-muted">
        <Icon name="chevronDown" />
      </span>
    </span>
  );
}
