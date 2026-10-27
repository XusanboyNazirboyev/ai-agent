'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { THEMES, usePreferences, type Theme } from '@/lib/preferences';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Icon, type IconName } from './ui/icons';

const THEME_ICON: Record<Theme, IconName> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
};

function Card(props: {
  title: string;
  description?: string;
  icon: IconName;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5">
      <header className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-fg">
          <Icon name={props.icon} className="h-5 w-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-semibold">{props.title}</h2>
          {props.description ? (
            <p className="text-sm text-muted">{props.description}</p>
          ) : null}
        </div>
      </header>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <dt className="text-sm text-muted">{props.label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words">
        {props.children}
      </dd>
    </div>
  );
}

type Permission = 'granted' | 'denied' | 'default' | 'unsupported';

function readPermission(): Permission {
  return typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission;
}

/** Account details and per-browser preferences (nothing here is sent to the server). */
export function SettingsPage(): ReactNode {
  const { t } = useI18n();
  const { operator, timeZone } = useShell();
  const { sound, setSound, theme, setTheme } = usePreferences();
  const [permission, setPermission] = useState<Permission>('unsupported');
  useEffect(() => {
    // Notification exists only in the browser; read after hydration.
    setPermission(readPermission());
  }, []);

  async function enableNotifications(): Promise<void> {
    await Notification.requestPermission();
    setPermission(readPermission());
  }

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.settings')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto grid w-full max-w-4xl grid-cols-1 items-start gap-3 p-3 sm:gap-4 sm:p-6 lg:grid-cols-2">
        <p className="text-sm text-muted lg:col-span-2">
          {t('settings.intro')}
        </p>

        <Card title={t('settings.account')} icon="user">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={operator.displayName} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium">
                {operator.displayName}
              </span>
              <span className="text-sm text-muted">
                {t(`role.${operator.role}`)}
              </span>
            </div>
          </div>
          <dl className="flex flex-col gap-3">
            <Row label={t('settings.timezone')}>{timeZone ?? '—'}</Row>
          </dl>
        </Card>

        <Card
          title={t('settings.notifications')}
          description={t('settings.notificationsHint')}
          icon="bell"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium">{t('settings.sound')}</span>
            <Button
              size="sm"
              icon={sound ? 'volume' : 'volumeOff'}
              aria-pressed={sound}
              onClick={() => setSound(!sound)}
            >
              {sound ? t('header.soundOn') : t('header.soundOff')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              {t('settings.browserAlerts')}
              <Badge
                tone={
                  permission === 'granted'
                    ? 'success'
                    : permission === 'denied'
                      ? 'danger'
                      : 'neutral'
                }
                dot
              >
                {t(`permission.${permission}`)}
              </Badge>
            </span>
            {permission === 'default' ? (
              <Button
                size="sm"
                icon="bell"
                onClick={() => void enableNotifications()}
              >
                {t('header.notifications')}
              </Button>
            ) : null}
          </div>
        </Card>

        <Card
          title={t('settings.appearance')}
          description={t('settings.appearanceHint')}
          icon="sun"
        >
          <div
            role="radiogroup"
            aria-label={t('settings.theme')}
            className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1"
          >
            {THEMES.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={theme === id}
                onClick={() => setTheme(id)}
                className={`flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors ${
                  theme === id
                    ? 'bg-surface text-fg shadow-card'
                    : 'text-muted hover:text-fg'
                }`}
              >
                <Icon name={THEME_ICON[id]} />
                <span className="truncate">{t(`theme.${id}`)}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
