'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { usePreferences } from '@/lib/preferences';
import type { Role } from '@/lib/types';
import { Avatar } from './ui/avatar';
import { Icon } from './ui/icons';

/** The theme now on screen: the chosen one, or the system's. */
function effectiveDark(theme: 'system' | 'light' | 'dark'): boolean {
  if (theme !== 'system') return theme === 'dark';
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  );
}

/** Owner 2026-11-23: one tap between light and dark. */
export function ThemeToggle(): ReactNode {
  const { t } = useI18n();
  const { theme, setTheme } = usePreferences();
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(effectiveDark(theme)), [theme]);
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      aria-label={dark ? t('header.themeLight') : t('header.themeDark')}
      title={dark ? t('header.themeLight') : t('header.themeDark')}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      <Icon name={dark ? 'sun' : 'moon'} className="h-5 w-5" />
    </button>
  );
}

/**
 * Owner 2026-11-23: a compact account button (avatar, short name, role);
 * signing out lives in its menu, out of the way of everyday clicks.
 */
export function UserMenu(props: {
  name: string;
  role: Role;
  onLogout: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent): void => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !root.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return (): void => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="user-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('header.account')}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-2"
      >
        <Avatar name={props.name} size="sm" />
        <span
          data-testid="operator"
          className="hidden min-w-0 flex-col text-left leading-tight lg:flex"
        >
          <span className="max-w-28 truncate text-sm font-semibold">
            {props.name}
          </span>
          <span className="text-xs text-muted">{t(`role.${props.role}`)}</span>
        </span>
        <Icon
          name="chevronDown"
          className="hidden h-4 w-4 text-muted lg:block"
        />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t('header.account')}
          className="absolute top-full right-0 z-30 mt-1 flex w-56 flex-col gap-1 rounded-xl border border-line bg-surface p-2 shadow-card"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-semibold">{props.name}</p>
            <p className="text-xs text-muted">{t(`role.${props.role}`)}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="logout"
            onClick={props.onLogout}
            className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm font-medium text-danger-fg hover:bg-danger-soft"
          >
            <Icon name="logout" />
            {t('header.logout')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
