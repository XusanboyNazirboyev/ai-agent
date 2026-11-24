'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { usePreferences } from '@/lib/preferences';
import { feedHref, type FeedItem } from '@/lib/notification-feed';
import type { Role } from '@/lib/types';
import { NotificationControl } from './notification-control';
import { Avatar } from './ui/avatar';
import { Icon, type IconName } from './ui/icons';

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
      // On a phone the header is too narrow; Settings > General has the theme.
      className="hidden h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:grid"
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

const FEED_ICON: Record<FeedItem['type'], IconName> = {
  'handover.created': 'headset',
  'handover.sla_breached': 'clock',
  'task.due': 'check',
  'subscription.bot_paused': 'alert',
  'subscription.past_due': 'card',
  'subscription.expired': 'card',
};

const FEED_TEXT: Record<FeedItem['type'], string> = {
  'handover.created': 'notify.newHandover',
  'handover.sla_breached': 'notify.slaBreached',
  'task.due': 'notify.task.due',
  'subscription.bot_paused': 'notify.subscription.bot_paused',
  'subscription.past_due': 'notify.subscription.past_due',
  'subscription.expired': 'notify.subscription.expired',
};

/**
 * Owner 2026-11-24: a bell in the header keeps every event that needs a
 * person; the number shows what is still unread.
 */
export function NotificationBell(props: {
  items: readonly FeedItem[];
  onOpen: (item: FeedItem, href: string) => void;
  onMarkAllRead: () => void;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const unread = props.items.filter((item) => !item.read).length;
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
        data-testid="notification-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          unread > 0 ? t('notify.unread', { count: unread }) : t('notify.bell')
        }
        onClick={() => setOpen((value) => !value)}
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <Icon name="bell" className="h-5 w-5" />
        {unread > 0 ? (
          <span
            data-testid="notification-count"
            className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[0.625rem] leading-4 font-semibold text-white"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('notify.bell')}
          data-testid="notification-panel"
          className="absolute top-full right-0 z-30 mt-1 flex max-h-[70vh] w-80 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-line bg-surface shadow-card"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold">{t('notify.bell')}</h2>
            {unread > 0 ? (
              <button
                type="button"
                data-testid="notification-read-all"
                onClick={props.onMarkAllRead}
                className="text-xs font-medium text-primary-fg hover:underline"
              >
                {t('notify.markAll')}
              </button>
            ) : null}
          </div>
          {props.items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">
              {t('notify.empty')}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {props.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid="notification-item"
                    data-read={item.read}
                    onClick={() => {
                      setOpen(false);
                      props.onOpen(item, feedHref(item));
                    }}
                    className={`flex w-full items-start gap-2.5 border-b border-line px-3 py-2.5 text-left text-sm hover:bg-surface-2 ${
                      item.read ? 'text-muted' : ''
                    }`}
                  >
                    <Icon
                      name={FEED_ICON[item.type]}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={item.read ? '' : 'font-medium'}>
                        {item.title ?? t(FEED_TEXT[item.type])}
                      </span>
                      <span className="text-xs text-muted">
                        {formatDateTime(item.at)}
                      </span>
                    </span>
                    {item.read ? null : (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line px-3 py-2">
            <NotificationControl />
          </div>
        </div>
      ) : null}
    </div>
  );
}
