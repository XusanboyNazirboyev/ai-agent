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
import {
  useLiveUpdates,
  type ConnectionState,
  type LiveEvent,
} from '@/lib/live-updates';
import { usePreferences } from '@/lib/preferences';
import type { ConversationPage, Me, Role } from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { LocaleSwitcher } from './locale-switcher';
import { Avatar } from './ui/avatar';
import { Badge, type Tone } from './ui/badge';
import { BrandMark } from './ui/brand';
import { Button } from './ui/button';
import { Icon, type IconName } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

interface ShellValue {
  operator: { id: string; displayName: string; role: Role };
  timeZone: string | undefined;
  waitingCount: number;
  connection: ConnectionState;
}

const ShellContext = createContext(undefined as ShellValue | undefined);

/** The signed-in operator and live state, for pages inside the shell. */
export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside AppShell');
  return value;
}

type NavKey =
  | 'inbox'
  | 'leads'
  | 'contacts'
  | 'bot'
  | 'knowledge'
  | 'channels'
  | 'settings';

const NAV: { key: NavKey; icon: IconName }[] = [
  { key: 'inbox', icon: 'inbox' },
  { key: 'leads', icon: 'target' },
  { key: 'contacts', icon: 'users' },
  { key: 'bot', icon: 'bot' },
  { key: 'knowledge', icon: 'book' },
  { key: 'channels', icon: 'link' },
  { key: 'settings', icon: 'sliders' },
];

/** On phones only these fit the tab bar; the rest sit behind "More". */
const PRIMARY: NavKey[] = ['inbox', 'leads', 'contacts'];

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

function NavLink(props: {
  href: string;
  icon: IconName;
  label: string;
  active: boolean;
  count?: number;
  layout: 'rail' | 'bar';
}): ReactNode {
  return (
    <Link
      href={props.href}
      aria-current={props.active ? 'page' : undefined}
      className={`group flex min-w-0 flex-col items-center gap-1 rounded-xl px-0.5 py-1.5 text-center text-[0.6875rem] leading-tight font-medium ${
        props.layout === 'rail' ? 'w-full' : 'flex-1'
      } ${props.active ? 'text-fg' : 'text-muted hover:text-fg'}`}
    >
      <span
        className={`relative grid h-8 w-12 place-items-center rounded-full transition-colors ${
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
  const onEvent = useCallback((event: LiveEvent) => {
    if (event.type !== 'handover.created') return;
    if (soundRef.current) beep();
    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    )
      new Notification(tRef.current('notify.newHandover'), { tag: 'handover' });
  }, []);
  const connection = useLiveUpdates(me.isSuccess, onEvent);

  const waiting = useQuery({
    queryKey: ['conversations', 'waiting-count'],
    queryFn: () =>
      api<ConversationPage>(
        '/api/v1/inbox/conversations?scope=waiting&limit=50',
      ),
    enabled: me.isSuccess,
  });
  const waitingCount = waiting.data?.items.length ?? 0;
  const now = useNow();
  const overdue = (waiting.data?.items ?? []).filter(
    (item) => item.slaDueAt && Date.parse(item.slaDueAt) < now,
  ).length;

  const current = NAV.find((item) => pathname.startsWith(`/${item.key}`));
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
      <div className="flex h-dvh flex-col" role="status">
        <span className="sr-only">{t('app.loading')}</span>
        <SkeletonRows rows={6} />
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
  const conversationOpen = pathname.startsWith('/inbox') && params.has('c');
  const value: ShellValue = {
    operator,
    timeZone: me.data.tenant?.timezone,
    waitingCount,
    connection,
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
          className="hidden w-[5.5rem] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface px-1 py-3 md:flex"
        >
          <span className="mb-3 grid h-10 w-full place-items-center">
            <BrandMark className="h-8 w-9" />
          </span>
          {NAV.map((item) => (
            <NavLink
              key={item.key}
              layout="rail"
              href={`/${item.key}`}
              icon={item.icon}
              label={t(`nav.${item.key}`)}
              active={current?.key === item.key}
              count={item.key === 'inbox' ? waitingCount : undefined}
            />
          ))}
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
              <LocaleSwitcher />
              <span className="hidden items-center gap-2 rounded-lg border border-line px-2 py-1 sm:flex">
                <Avatar name={operator.displayName} size="sm" />
                <span
                  data-testid="operator"
                  className="sr-only text-sm lg:not-sr-only"
                >
                  {t('header.signedInAs', {
                    name: operator.displayName,
                    role: t(`role.${operator.role}`),
                  })}
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                icon="logout"
                onClick={() => void logout()}
              >
                <span className="sr-only sm:not-sr-only">
                  {t('header.logout')}
                </span>
              </Button>
            </div>
          </header>
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
            {children}
          </main>
          {conversationOpen ? null : (
            <nav
              aria-label={t('nav.label')}
              className="flex shrink-0 border-t border-line bg-surface px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden"
            >
              {NAV.filter((item) => PRIMARY.includes(item.key)).map((item) => (
                <NavLink
                  key={item.key}
                  layout="bar"
                  href={`/${item.key}`}
                  icon={item.icon}
                  label={t(`nav.${item.key}`)}
                  active={current?.key === item.key}
                  count={item.key === 'inbox' ? waitingCount : undefined}
                />
              ))}
              <NavLink
                layout="bar"
                href="/more"
                icon="more"
                label={t('nav.more')}
                active={
                  onMore || (current ? !PRIMARY.includes(current.key) : false)
                }
              />
            </nav>
          )}
        </div>
      </div>
    </ShellContext.Provider>
  );
}
