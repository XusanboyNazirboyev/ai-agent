'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { api, ApiError } from '@/lib/api';
import { NAV, navHref, visibleNav, type NavKey } from '@/lib/nav';
import { PAGE_PREFETCH } from '@/lib/page-prefetch';
import { waitingCountQuery } from '@/lib/queries';
import {
  useLiveUpdates,
  type ConnectionState,
  type LiveEvent,
} from '@/lib/live-updates';
import { usePreferences } from '@/lib/preferences';
import { canManageTeam } from '@/lib/roles';
import type { Me, Role, TenantAccess } from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { LeadLimitBanner } from './lead-limit-banner';
import { accessNotice } from '@/lib/access-notice';
import { showTaskNotification } from '@/lib/browser-notify';
import { LocaleSwitcher } from './locale-switcher';
import { NotificationBell, ThemeToggle, UserMenu } from './header-controls';
import { navKeyOf, useAppUpdates } from '@/lib/app-updates';
import { useNotificationFeed } from '@/lib/notification-feed';
import { PageLoading } from './page-loading';
import { Badge, type Tone } from './ui/badge';
import { BrandMark } from './ui/brand';
import { Button } from './ui/button';
import { Icon, type IconName } from './ui/icons';
import { useToast } from './ui/toast';

interface ShellValue {
  operator: { id: string; displayName: string; role: Role };
  timeZone: string | undefined;
  waitingCount: number;
  connection: ConnectionState;
  /** Menu items with a release note not opened yet (owner 2026-11-25). */
  freshNav: NavKey[];
  freshPaths: string[];
}

const ShellContext = createContext(undefined as ShellValue | undefined);

/** The signed-in operator and live state, for pages inside the shell. */
export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside AppShell');
  return value;
}

/** On phones only these fit the tab bar; the rest sit behind "More". */
export const PRIMARY: NavKey[] = ['today', 'inbox', 'crm'];

/**
 * Pages inside a section everyone opens that only owners and admins may read
 * (the CRM report and calls, 2026-11-24): others get the access screen.
 */
const MANAGER_PATHS = ['/analytics', '/calls'];

/** Numerals and a plus sign: the same in every language. */
const COUNT_CAP_LABEL = '99+';

const CONNECTION_TONE: Record<string, Tone> = {
  live: 'success',
  connecting: 'warning',
  reconnecting: 'warning',
  polling: 'danger',
};

function beep(): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 880;
    oscillator.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.15);
  } catch {
    // No audio permission: the visual cues remain.
  }
}

/**
 * The "new here" mark of a menu item (owner 2026-11-25). Visual only: the
 * bell names the change, and the link keeps its plain accessible name.
 */
export function FreshDot(): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-testid="nav-fresh"
      className="absolute top-0.5 right-1.5 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-surface"
    />
  );
}

function NavLink(props: {
  href: string;
  icon: IconName;
  label: string;
  active: boolean;
  count?: number;
  /** A release note for this place is not opened yet. */
  fresh?: boolean;
  layout: 'rail' | 'bar';
  /** Starts the page's reads when the pointer or focus arrives (2026-11-24). */
  onIntent?: () => void;
}): ReactNode {
  return (
    <Link
      href={props.href}
      // Do not download every visible menu destination on initial load.
      // The route and its first reads are warmed together on real intent.
      prefetch={false}
      onMouseEnter={props.onIntent}
      onFocus={props.onIntent}
      onTouchStart={props.onIntent}
      aria-current={props.active ? 'page' : undefined}
      className={`group flex min-w-0 flex-col items-center rounded-xl px-0.5 text-center text-[0.6875rem] leading-tight font-medium ${
        props.layout === 'rail' ? 'w-full gap-1 py-1.5' : 'flex-1 gap-0.5 py-1'
      } ${props.active ? 'text-fg' : 'text-muted hover:text-fg'}`}
    >
      <span
        className={`relative grid h-7 w-11 place-items-center rounded-full transition-colors ${
          props.active
            ? 'bg-primary-soft text-primary-fg'
            : 'group-hover:bg-surface-2'
        }`}
      >
        <Icon name={props.icon} className="h-5 w-5" />
        {props.count ? (
          <span
            data-testid={`nav-count-${props.icon}`}
            className="absolute top-0 right-0 min-w-5 rounded-full bg-primary px-1 text-center text-[0.6875rem] leading-5 font-semibold text-white"
          >
            {props.count > 99 ? COUNT_CAP_LABEL : props.count}
          </span>
        ) : props.fresh ? (
          <FreshDot />
        ) : null}
      </span>
      <span className="max-w-full break-words">{props.label}</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { sound } = usePreferences();
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/api/v1/auth/me'),
    retry: false,
  });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401)
      router.replace('/login');
  }, [me.error, router]);

  const tRef = useRef(t);
  tRef.current = t;
  const toast = useToast();
  const pausedNoticeShown = useRef(false);
  const onHandover = (event: LiveEvent): void => {
    if (event.type !== 'handover.created') return;
    if (soundRef.current) beep();
    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    )
      new Notification(tRef.current('notify.newHandover'), { tag: 'handover' });
  };
  const feed = useNotificationFeed(me.data?.operator?.id);
  const updates = useAppUpdates(me.data?.operator?.id, pathname);
  const bellItems = [...updates.items, ...feed.items].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const addToFeed = feed.add;
  const onEvent = useCallback(
    (event: LiveEvent) => {
      // Owner 2026-11-24: every event that needs a person goes to the bell.
      addToFeed(event);
      if (event.type === 'task.due') {
        // A task's time came: refresh the lists and say so once.
        void queryClient.invalidateQueries({ queryKey: ['tasks-mine'] });
        void queryClient.invalidateQueries({ queryKey: ['tasks-page'] });
        void queryClient.invalidateQueries({ queryKey: ['lead-tasks'] });
        if (soundRef.current) beep();
        toast(tRef.current('notify.task.due'));
        showTaskNotification({
          title: tRef.current('tasks.notify.title'),
          body: event.taskTitle || tRef.current('notify.task.due'),
          onClick: () => router.push('/tasks'),
        });
        return;
      }
      if (event.type.startsWith('subscription.')) {
        // The access answer changed: refetch it (banner) and say so once.
        void queryClient.invalidateQueries({ queryKey: ['me'] });
        void queryClient.invalidateQueries({ queryKey: ['subscription'] });
        if (event.type === 'subscription.bot_paused') {
          if (pausedNoticeShown.current) return;
          pausedNoticeShown.current = true;
        }
        toast(tRef.current(`notify.${event.type}`));
        return;
      }
      onHandover(event);
    },
    [queryClient, toast, router, addToFeed],
  );
  const connection = useLiveUpdates(me.isSuccess, onEvent);

  const waiting = useQuery({ ...waitingCountQuery, enabled: me.isSuccess });
  const waitingCount = waiting.data?.items.length ?? 0;
  const now = useNow();
  const overdue = (waiting.data?.items ?? []).filter(
    (item) => item.slaDueAt && Date.parse(item.slaDueAt) < now,
  ).length;

  const currentKey = navKeyOf(pathname);
  const current = NAV.find((item) => item.key === currentKey);
  const onMore = pathname.startsWith('/more');
  const title = onMore
    ? t('nav.more')
    : current
      ? t(`nav.${current.key}`)
      : t('app.title');
  useEffect(() => {
    document.title = `${waitingCount > 0 ? `(${waitingCount}) ` : ''}${title} · ${t('app.brand')}`;
  }, [waitingCount, title, t]);

  async function logout(): Promise<void> {
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      router.replace('/login');
    }
  }

  if (me.isPending) {
    return (
      <div className="h-dvh">
        <PageLoading />
      </div>
    );
  }
  if (me.isError || !me.data.operator) {
    return me.error instanceof ApiError && me.error.status === 401 ? null : (
      <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" />
          {t('errors.UNKNOWN')}
        </p>
        <Button variant="primary" onClick={() => void me.refetch()}>
          {t('app.retry')}
        </Button>
      </div>
    );
  }
  const operator = me.data.operator;
  const allowed = visibleNav(operator.role);
  const conversationOpen = pathname.startsWith('/inbox') && params.has('c');
  const value: ShellValue = {
    operator,
    timeZone: me.data.tenant?.timezone,
    waitingCount,
    connection,
    freshNav: updates.freshNav,
    freshPaths: updates.freshPaths,
  };
  const warmNav = (item: (typeof NAV)[number]): void => {
    const href = navHref(item);
    router.prefetch(href);
    PAGE_PREFETCH[item.key]?.(queryClient);
  };

  return (
    <ShellContext.Provider value={value}>
      <div className="flex h-dvh flex-col md:flex-row">
        <a
          href="#app-main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop"
        >
          {t('app.skip')}
        </a>
        <nav
          aria-label={t('nav.label')}
          className="hidden w-[4.5rem] shrink-0 flex-col items-center gap-3 overflow-y-auto border-r border-line bg-surface px-0.5 py-2 md:flex"
        >
          <span className="mb-2 grid h-9 w-full place-items-center">
            <BrandMark className="h-8 w-9" />
          </span>
          {visibleNav(operator.role).map((key) => {
            const item = NAV.find((i) => i.key === key)!;
            return (
              <NavLink
                key={item.key}
                layout="rail"
                href={navHref(item)}
                icon={item.icon}
                label={t(`nav.${item.key}`)}
                active={current?.key === item.key}
                count={item.key === 'inbox' ? waitingCount : undefined}
                fresh={updates.freshNav.includes(item.key)}
                onIntent={() => warmNav(item)}
              />
            );
          })}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <BrandMark className="h-7 w-8 shrink-0 md:hidden" />
              <h1 className="truncate text-lg font-semibold tracking-tight">
                {title}
              </h1>
              <span
                data-testid="connection"
                data-state={connection}
                className="shrink-0"
              >
                <Badge tone={CONNECTION_TONE[connection] ?? 'neutral'} dot>
                  <span className="sr-only sm:not-sr-only">
                    {t(`connection.${connection}`)}
                  </span>
                </Badge>
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 text-sm sm:gap-2">
              <NotificationBell
                items={bellItems}
                onOpen={(item, href) => {
                  if (item.updateId) updates.markSeen(item.updateId);
                  else feed.markRead(item.id);
                  router.push(href);
                }}
                onMarkAllRead={() => {
                  feed.markAllRead();
                  updates.markAllSeen();
                }}
              />
              <ThemeToggle />
              <LocaleSwitcher compact />
              <UserMenu
                name={operator.displayName}
                role={operator.role}
                onLogout={() => void logout()}
              />
            </div>
          </header>
          <AccessBanner
            access={me.data.access}
            manager={canManageTeam(operator.role)}
          />
          <LeadLimitBanner info={me.data.leadLimit} />
          {overdue > 0 ? (
            <div
              role="alert"
              data-testid="sla-banner"
              className="flex shrink-0 items-center gap-2 bg-warning-soft px-4 py-2 text-sm font-medium text-warning-fg"
            >
              <Icon name="clock" />
              {t('banner.sla', { count: overdue })}
            </div>
          ) : null}
          <main id="app-main" className="flex min-h-0 min-w-0 flex-1 flex-col">
            {(current && !allowed.includes(current.key)) ||
            (!canManageTeam(operator.role) &&
              MANAGER_PATHS.some((path) => pathname.startsWith(path))) ? (
              <AccessDenied />
            ) : (
              children
            )}
          </main>
          {conversationOpen ? null : (
            <nav
              aria-label={t('nav.label')}
              className="flex shrink-0 border-t border-line bg-surface px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden"
            >
              {PRIMARY.filter((key) => allowed.includes(key)).map((key) => {
                const item = NAV.find((i) => i.key === key)!;
                return (
                  <NavLink
                    key={item.key}
                    layout="bar"
                    href={navHref(item)}
                    icon={item.icon}
                    label={t(`nav.${item.key}`)}
                    active={current?.key === item.key}
                    count={item.key === 'inbox' ? waitingCount : undefined}
                    fresh={updates.freshNav.includes(item.key)}
                    onIntent={() => warmNav(item)}
                  />
                );
              })}
              <NavLink
                layout="bar"
                href="/more"
                icon="more"
                label={t('nav.more')}
                active={
                  onMore || (current ? !PRIMARY.includes(current.key) : false)
                }
                fresh={updates.freshNav.some((key) => !PRIMARY.includes(key))}
                onIntent={() => router.prefetch('/more')}
              />
            </nav>
          )}
        </div>
      </div>
    </ShellContext.Provider>
  );
}

/**
 * Subscription state from `GET /me` (ADR 047 §3): expired means the assistant
 * is paused while people can still answer by hand; past due (a grace date
 * while still `ok`) warns before that happens; "ends soon" reminds managers
 * in the last days of a running period.
 */
export function AccessBanner(props: {
  access: TenantAccess | undefined;
  manager: boolean;
}): ReactNode {
  const { t, locale } = useI18n();
  const now = useNow(60 * 60_000);
  const access = props.access;
  const notice = accessNotice(access, props.manager, now);
  if (!access || !notice) return null;
  const expired = notice === 'expired';
  const shown = notice === 'ending-soon' ? access.periodEnd : access.graceUntil;
  const date = shown
    ? new Intl.DateTimeFormat(locale === 'uz-Latn' ? 'uz-Latn' : locale, {
        dateStyle: 'medium',
      }).format(new Date(shown))
    : '';
  return (
    <div
      role={notice === 'ending-soon' ? 'status' : 'alert'}
      data-testid="access-banner"
      data-state={notice}
      className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm font-medium ${
        expired
          ? 'bg-danger-soft text-danger-fg'
          : 'bg-warning-soft text-warning-fg'
      }`}
    >
      <span className="flex min-w-0 items-start gap-2">
        <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {expired
            ? t('banner.expired')
            : notice === 'ending-soon'
              ? t('banner.endingSoon', { date })
              : t('banner.pastDue', { date })}
        </span>
      </span>
      {props.manager ? (
        <Link href="/billing" className="underline underline-offset-2">
          {t('banner.subscriptionLink')}
        </Link>
      ) : null}
    </div>
  );
}

function AccessDenied(): ReactNode {
  const { t } = useI18n();
  return (
    <div
      data-testid="access-denied"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <p
        role="alert"
        className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
      >
        {t('access.notAllowed')}
      </p>
      <Link
        href="/inbox"
        className="text-primary-fg underline underline-offset-2"
      >
        {t('access.goToInbox')}
      </Link>
    </div>
  );
}
