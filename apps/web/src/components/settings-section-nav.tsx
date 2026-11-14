'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { canManageTeam } from '@/lib/roles';
import { useShell } from './app-shell';
import { Icon, type IconName } from './ui/icons';

export type SettingsSection =
  | 'bot'
  | 'channels'
  | 'crm'
  | 'pipeline'
  | 'catalog'
  | 'fields'
  | 'team'
  | 'subscription'
  | 'security'
  | 'general';

const SECTIONS: {
  key: SettingsSection;
  href: string;
  icon: IconName;
  /** OWNER and ADMIN only (ADR 047 §5). */
  managers?: boolean;
}[] = [
  { key: 'bot', href: '/settings/bot', icon: 'bot' },
  { key: 'channels', href: '/settings/channels', icon: 'link' },
  { key: 'crm', href: '/settings/crm', icon: 'database' },
  { key: 'pipeline', href: '/settings/pipeline', icon: 'target' },
  {
    key: 'catalog',
    href: '/settings/catalog',
    icon: 'book',
    managers: true,
  },
  { key: 'fields', href: '/settings/fields', icon: 'tag' },
  { key: 'team', href: '/settings/team', icon: 'users', managers: true },
  {
    key: 'subscription',
    href: '/settings/subscription',
    icon: 'clock',
    managers: true,
  },
  { key: 'security', href: '/settings/security', icon: 'lock' },
  { key: 'general', href: '/settings', icon: 'sliders' },
];

export function SettingsSectionNav(props: {
  active: SettingsSection;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const manager = canManageTeam(operator.role);
  return (
    <nav
      aria-label={t('settings.sections')}
      className="shrink-0 overflow-x-auto border-b border-line bg-surface px-2 py-2 sm:px-4"
    >
      <ul className="flex w-max min-w-full gap-1">
        {SECTIONS.filter((section) => manager || !section.managers).map(
          (section) => (
            <li key={section.key}>
              <Link
                href={section.href}
                aria-current={props.active === section.key ? 'page' : undefined}
                className={`flex min-h-10 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors ${
                  props.active === section.key
                    ? 'bg-primary-soft text-primary-fg'
                    : 'text-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                <Icon name={section.icon} className="h-4 w-4" />
                {t(`settings.section.${section.key}`)}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

export function SettingsSubPage(props: {
  active: Exclude<SettingsSection, 'general'>;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsSectionNav active={props.active} />
      {props.children}
    </div>
  );
}
