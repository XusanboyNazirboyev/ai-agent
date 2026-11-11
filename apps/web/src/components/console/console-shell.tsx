'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { ApiError, platformApi } from '@/lib/api';
import type { PlatformAdmin, PlatformMe } from '@/lib/platform-types';
import { canWritePlatform } from '@/lib/roles';
import { LocaleSwitcher } from '../locale-switcher';
import { Avatar } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { BrandMark } from '../ui/brand';
import { Button } from '../ui/button';
import { Icon, type IconName } from '../ui/icons';
import { SkeletonRows } from '../ui/skeleton';

interface ConsoleValue {
  admin: PlatformAdmin;
  /** PLATFORM_OWNER; SUPPORT sees the same screens read-only. */
  canWrite: boolean;
}

const ConsoleContext = createContext(undefined as ConsoleValue | undefined);

export function useConsole(): ConsoleValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error('useConsole must be used inside ConsoleShell');
  return value;
}

type Section = 'tenants' | 'plans' | 'admins' | 'audit' | 'security';

const NAV: { key: Section; href: string; icon: IconName; owner?: boolean }[] = [
  { key: 'tenants', href: '/console', icon: 'users' },
  { key: 'plans', href: '/console/plans', icon: 'database' },
  { key: 'admins', href: '/console/admins', icon: 'user', owner: true },
  { key: 'audit', href: '/console/audit', icon: 'note' },
  { key: 'security', href: '/console/security', icon: 'lock' },
];

function sectionOf(pathname: string): Section {
  if (pathname.startsWith('/console/plans')) return 'plans';
  if (pathname.startsWith('/console/admins')) return 'admins';
  if (pathname.startsWith('/console/audit')) return 'audit';
  if (pathname.startsWith('/console/security')) return 'security';
  return 'tenants';
}

/**
 * The platform console frame (ADR 047 §4): its own session (`ac_platform`),
 * no tenant navigation. Signed-out visitors go to the console sign-in.
 */
export function ConsoleShell({ children }: { children: ReactNode }): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['platform', 'me'],
    queryFn: () => platformApi<PlatformMe>('/api/v1/platform/auth/me'),
    retry: false,
  });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401)
      router.replace('/console/login');
  }, [me.error, router]);

  const section = sectionOf(pathname);
  const title = t(`console.nav.${section}`);
  useEffect(() => {
    document.title = `${title} · ${t('console.title')}`;
  }, [title, t]);

  async function logout(): Promise<void> {
    try {
      await platformApi('/api/v1/platform/auth/logout', { method: 'POST' });
    } finally {
      queryClient.removeQueries({ queryKey: ['platform'] });
      router.replace('/console/login');
    }
  }

  if (me.isPending)
    return (
      <div className="flex h-dvh flex-col" role="status">
        <span className="sr-only">{t('app.loading')}</span>
        <SkeletonRows rows={6} />
      </div>
    );
  if (me.isError || !me.data.admin)
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

  const admin = me.data.admin;
  const value: ConsoleValue = {
    admin,
    canWrite: canWritePlatform(admin.role),
  };
  const nav = NAV.filter((item) => !item.owner || value.canWrite);

  return (
    <ConsoleContext.Provider value={value}>
      <div className="flex min-h-dvh flex-col bg-canvas">
        <a
          href="#console-main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop"
        >
          {t('console.skip')}
        </a>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2 sm:px-6">
          <Link
            href="/console"
            className="flex min-w-0 items-center gap-2 rounded-lg"
          >
            <BrandMark className="h-7 w-8 shrink-0" />
            <span className="text-lg font-extrabold tracking-tight text-brand italic">
              {t('app.brand')}
            </span>
            <Badge tone="accent">{t('console.badge')}</Badge>
          </Link>
          <div className="flex shrink-0 items-center gap-1.5 text-sm sm:gap-2">
            <LocaleSwitcher />
            <span className="hidden items-center gap-2 rounded-lg border border-line px-2 py-1 sm:flex">
              <Avatar name={admin.displayName} size="sm" />
              <span
                data-testid="console-admin"
                className="sr-only text-sm lg:not-sr-only"
              >
                {t('header.signedInAs', {
                  name: admin.displayName,
                  role: t(`platformRole.${admin.role}`),
                })}
              </span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon="logout"
              data-testid="console-logout"
              onClick={() => void logout()}
            >
              <span className="sr-only sm:not-sr-only">
                {t('header.logout')}
              </span>
            </Button>
          </div>
        </header>
        <nav
          aria-label={t('console.navLabel')}
          className="shrink-0 overflow-x-auto border-b border-line bg-surface px-2 py-2 sm:px-6"
        >
          <ul className="flex w-max min-w-full gap-1">
            {nav.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={section === item.key ? 'page' : undefined}
                  className={`flex min-h-10 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors ${
                    section === item.key
                      ? 'bg-primary-soft text-primary-fg'
                      : 'text-muted hover:bg-surface-2 hover:text-fg'
                  }`}
                >
                  <Icon name={item.icon} className="h-4 w-4" />
                  {t(`console.nav.${item.key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {value.canWrite ? null : (
          <p
            role="status"
            data-testid="read-only-banner"
            className="flex items-center gap-2 bg-surface-2 px-4 py-2 text-sm text-muted sm:px-6"
          >
            <Icon name="info" className="h-4 w-4 shrink-0" />
            {t('console.readOnly')}
          </p>
        )}
        <main id="console-main" className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4 p-3 sm:p-6">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {children}
          </div>
        </main>
      </div>
    </ConsoleContext.Provider>
  );
}
