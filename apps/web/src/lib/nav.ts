import type { IconName } from '../components/ui/icons';
import type { Role } from './types';

export type NavKey =
  'agent' | 'today' | 'inbox' | 'crm' | 'billing' | 'settings';

export interface NavItem {
  key: NavKey;
  icon: IconName;
  /** Roles that may open this item. Items useful even read-only stay; only
   * a "not allowed" item is hidden from the rail and the "More" page. */
  roles: Role[];
  /** Where the item leads when it is not `/<key>`. */
  href?: string;
  /** Other top-level paths that belong under this item (the menu keeps it lit). */
  alsoUnder?: string[];
}

/** One source of truth for the top-level menu. */
export const NAV: NavItem[] = [
  // Owner 2026-11-23: the AI agent is its own section, first in the menu.
  {
    key: 'agent',
    icon: 'bot',
    roles: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
    alsoUnder: ['/knowledge', '/settings/bot', '/settings/catalog'],
  },
  {
    key: 'today',
    icon: 'sun',
    roles: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
  },
  {
    key: 'inbox',
    icon: 'inbox',
    roles: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
  },
  // Owner 2026-11-24: leads, tasks, calls and the CRM report in one place.
  {
    key: 'crm',
    icon: 'target',
    roles: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
    href: '/leads',
    alsoUnder: ['/leads', '/contacts', '/tasks', '/calls', '/analytics'],
  },
  // Owner 2026-11-23: the plan, its period and the prices in plain sight.
  {
    key: 'billing',
    icon: 'card',
    roles: ['OWNER', 'ADMIN'],
    alsoUnder: ['/settings/subscription'],
  },
  {
    key: 'settings',
    icon: 'sliders',
    roles: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
  },
];

/** Top-level nav keys the given role may see, in menu order. */
export function visibleNav(role: Role): NavKey[] {
  return NAV.filter((item) => item.roles.includes(role)).map(
    (item) => item.key,
  );
}

export function isNavAllowed(key: NavKey, role: Role): boolean {
  return visibleNav(role).includes(key);
}

/** The address a menu item opens. */
export function navHref(item: NavItem): string {
  return item.href ?? `/${item.key}`;
}
