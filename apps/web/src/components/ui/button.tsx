'use client';

import {
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Icon, Spinner, type IconName } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover',
  secondary: 'border border-line bg-surface text-fg hover:bg-surface-2',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:bg-danger-hover',
};

/** The ring is white on a filled button and the brand colour elsewhere. */
const PING: Record<ButtonVariant, string> = {
  primary: 'text-white',
  secondary: 'text-primary',
  ghost: 'text-primary',
  danger: 'text-white',
};

/** Also used by links that look like buttons: they get the press, not the ring. */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: 'sm' | 'md' = 'md',
): string {
  return `tz-press inline-flex items-center justify-center gap-2 rounded-lg font-medium disabled:cursor-not-allowed disabled:opacity-55 ${
    size === 'sm' ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-4 text-sm'
  } ${VARIANT[variant]}`;
}

interface Ping {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Diameter that reaches the farthest corner from the pressed point. */
  readonly size: number;
}

function pingAt(rect: DOMRect, x: number, y: number, id: number): Ping {
  const dx = Math.max(x, rect.width - x);
  const dy = Math.max(y, rect.height - y);
  return { id, x, y, size: Math.ceil(2 * Math.hypot(dx, dy)) };
}

/** The label is children text; the icon is decorative. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  className = '',
  disabled,
  children,
  type = 'button',
  onPointerDown,
  onKeyDown,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  loading?: boolean;
}): ReactNode {
  const [pings, setPings] = useState<readonly Ping[]>([]);
  const next = useRef(0);
  const inactive = disabled || loading;

  function add(rect: DOMRect, x: number, y: number): void {
    next.current += 1;
    const ping = pingAt(rect, x, y, next.current);
    // At most three rings at once, so fast clicking never piles them up.
    setPings((current) => [...current.slice(-2), ping]);
  }

  return (
    <button
      type={type}
      disabled={inactive}
      aria-busy={loading || undefined}
      className={`${buttonClass(variant, size)} relative ${className}`}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerDown?.(event);
        if (inactive || event.button > 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        add(rect, event.clientX - rect.left, event.clientY - rect.top);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(event);
        if (inactive || event.repeat) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const rect = event.currentTarget.getBoundingClientRect();
        add(rect, rect.width / 2, rect.height / 2);
      }}
      {...rest}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
      {pings.length > 0 ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] ${PING[variant]}`}
        >
          {pings.map((ping) => (
            <span
              key={ping.id}
              data-ping=""
              className="tz-ping"
              style={
                {
                  left: ping.x,
                  top: ping.y,
                  '--tz-ping-size': `${ping.size}px`,
                } as CSSProperties
              }
              onAnimationEnd={() =>
                setPings((current) => current.filter((p) => p.id !== ping.id))
              }
            />
          ))}
        </span>
      ) : null}
    </button>
  );
}
