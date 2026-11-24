'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { canManageTeam } from '@/lib/roles';
import { useShell } from './app-shell';

export type CrmSection = 'leads' | 'tasks' | 'calls' | 'report';

/**
 * Owner 2026-11-24: one CRM section, like the reference CRM: leads, tasks,
 * calls and the report together. Calls and the report are for owners and
 * admins, as their data is.
 */
export const CRM_SECTIONS: readonly {
  key: CrmSection;
  href: string;
  managers?: boolean;
}[] = [
  { key: 'leads', href: '/leads' },
  { key: 'tasks', href: '/tasks' },
  { key: 'calls', href: '/calls', managers: true },
  { key: 'report', href: '/analytics', managers: true },
];

export function visibleCrmSections(manager: boolean): typeof CRM_SECTIONS {
  return CRM_SECTIONS.filter((section) => manager || !section.managers);
}

export function CrmSubPage(props: {
  active: CrmSection;
  children: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label={t('nav.crm')}
        data-testid="crm-tabs"
        className="shrink-0 overflow-x-auto border-b border-line bg-surface px-2 py-1.5 sm:px-4"
      >
        <ul className="flex w-max min-w-full gap-1">
          {visibleCrmSections(canManageTeam(operator.role)).map((section) => (
            <li key={section.key}>
              <Link
                href={section.href}
                data-testid={`crm-tab-${section.key}`}
                aria-current={props.active === section.key ? 'page' : undefined}
                className={`flex min-h-9 items-center whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors ${
                  props.active === section.key
                    ? 'bg-surface-2 text-fg underline decoration-primary decoration-2 underline-offset-8'
                    : 'text-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                {t(`crm.tab.${section.key}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {props.children}
    </div>
  );
}
