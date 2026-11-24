'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { canManageTeam } from '@/lib/roles';
import { useShell } from './app-shell';
import { Icon, type IconName } from './ui/icons';

export type SettingsSection =
  | 'crm'
  | 'telephony'
  | 'pipeline'
  | 'fields'
  | 'team'
  | 'security'
  | 'history'
  | 'general';

interface SectionDef {
  key: SettingsSection;
  href: string;
  /** The catalog key of the label (the sub-tab). */
  label: string;
  /** OWNER and ADMIN only (ADR 047 §5). */
  managers?: boolean;
}

interface GroupDef {
  key: 'integrations' | 'sales' | 'account';
  icon: IconName;
  sections: SectionDef[];
}

/**
 * Owner 2026-11-24: settings in three groups: integrations (CRMs and
 * telephony), sales stages (with their tags and fields), and general (team,
 * security, history and the account). Each section keeps its own address.
 */
export const SETTINGS_GROUPS: GroupDef[] = [
  {
    key: 'integrations',
    icon: 'link',
    sections: [
      { key: 'crm', href: '/settings/crm', label: 'settings.section.crm' },
      {
        key: 'telephony',
        href: '/settings/telephony',
        label: 'settings.section.telephony',
        managers: true,
      },
    ],
  },
  {
    key: 'sales',
    icon: 'target',
    sections: [
      {
        key: 'pipeline',
        href: '/settings/pipeline',
        label: 'settings.section.pipeline',
      },
      {
        key: 'fields',
        href: '/settings/fields',
        label: 'settings.section.fields',
      },
    ],
  },
  {
    key: 'account',
    icon: 'users',
    sections: [
      {
        key: 'team',
        href: '/settings/team',
        label: 'settings.section.team',
        managers: true,
      },
      {
        key: 'security',
        href: '/settings/security',
        label: 'settings.section.security',
      },
      {
        key: 'history',
        href: '/settings/history',
        label: 'settings.section.history',
        managers: true,
      },
      { key: 'general', href: '/settings', label: 'settings.section.general' },
    ],
  },
];

/** The group a section belongs to. */
export function groupOf(section: SettingsSection): GroupDef['key'] {
  return SETTINGS_GROUPS.find((group) =>
    group.sections.some((s) => s.key === section),
  )!.key;
}

/** The sections a role may open in a group, in order. */
export function visibleSections(
  group: GroupDef,
  manager: boolean,
): SectionDef[] {
  return group.sections.filter((section) => manager || !section.managers);
}

export function SettingsSectionNav(props: {
  active: SettingsSection;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const manager = canManageTeam(operator.role);
  const activeGroup = groupOf(props.active);
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    visible: visibleSections(group, manager),
  })).filter((group) => group.visible.length > 0);
  const current = groups.find((group) => group.key === activeGroup);
  return (
    <div className="shrink-0 border-b border-line bg-surface">
      <nav
        aria-label={t('settings.sections')}
        className="grid grid-cols-3 gap-1 px-2 pt-2 sm:px-4"
      >
        {groups.map((group) => (
          <Link
            key={group.key}
            href={group.visible[0]!.href}
            data-testid={`settings-group-${group.key}`}
            aria-current={activeGroup === group.key ? 'page' : undefined}
            className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-center text-xs font-medium leading-tight transition-colors sm:flex-row sm:gap-2 sm:text-sm ${
              activeGroup === group.key
                ? 'bg-primary-soft text-primary-fg'
                : 'text-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <Icon name={group.icon} className="h-4 w-4 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {t(`settings.group.${group.key}`)}
            </span>
          </Link>
        ))}
      </nav>
      {current && current.visible.length > 1 ? (
        <nav
          aria-label={t(`settings.group.${current.key}`)}
          data-testid="settings-subtabs"
          className="overflow-x-auto px-2 py-1.5 sm:px-4"
        >
          <ul className="flex w-max min-w-full gap-1">
            {current.visible.map((section) => (
              <li key={section.key}>
                <Link
                  href={section.href}
                  data-testid={`settings-tab-${section.key}`}
                  aria-current={
                    props.active === section.key ? 'page' : undefined
                  }
                  className={`flex min-h-9 items-center whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors ${
                    props.active === section.key
                      ? 'bg-surface-2 text-fg underline decoration-primary decoration-2 underline-offset-8'
                      : 'text-muted hover:bg-surface-2 hover:text-fg'
                  }`}
                >
                  {t(section.label)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : (
        <div className="h-1.5" />
      )}
    </div>
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
