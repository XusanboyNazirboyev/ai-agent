'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { canManageTeam } from '@/lib/roles';
import { useShell } from './app-shell';

export type AgentSection =
  'dashboard' | 'knowledge' | 'rules' | 'prices' | 'test';

/**
 * Owner 2026-11-23: the AI agent is its own top-level section, first in the
 * menu, with everything that shapes its answers in one place.
 */
export const AGENT_SECTIONS: readonly {
  key: AgentSection;
  href: string;
  /** OWNER and ADMIN only, as these were under Settings (ADR 047 §5). */
  managers?: boolean;
}[] = [
  { key: 'dashboard', href: '/agent' },
  { key: 'knowledge', href: '/agent/knowledge' },
  { key: 'rules', href: '/agent/rules' },
  { key: 'prices', href: '/agent/prices', managers: true },
  { key: 'test', href: '/agent/test', managers: true },
];

/** The tabs a role may open, in order. */
export function visibleAgentSections(manager: boolean): typeof AGENT_SECTIONS {
  return AGENT_SECTIONS.filter((section) => manager || !section.managers);
}

export function AgentSubPage(props: {
  active: AgentSection;
  children: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  const { operator, freshPaths = [] } = useShell();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label={t('nav.agent')}
        data-testid="agent-tabs"
        className="shrink-0 overflow-x-auto border-b border-line bg-surface px-2 py-1.5 sm:px-4"
      >
        <ul className="flex w-max min-w-full gap-1">
          {visibleAgentSections(canManageTeam(operator.role)).map((section) => (
            <li key={section.key}>
              <Link
                href={section.href}
                data-testid={`agent-tab-${section.key}`}
                aria-current={props.active === section.key ? 'page' : undefined}
                className={`flex min-h-9 items-center whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors ${
                  props.active === section.key
                    ? 'bg-surface-2 text-fg underline decoration-primary decoration-2 underline-offset-8'
                    : 'text-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                {t(`agent.tab.${section.key}`)}
                {freshPaths.includes(section.href) ? (
                  <span
                    aria-hidden="true"
                    data-testid={`agent-tab-fresh-${section.key}`}
                    className="ml-1.5 h-2 w-2 rounded-full bg-danger"
                  />
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {props.children}
    </div>
  );
}
