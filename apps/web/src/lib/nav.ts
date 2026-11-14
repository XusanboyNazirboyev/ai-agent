import type { IconName } from '../components/ui/icons';
import type { Role } from './types';

export type NavKey =
  'today' | 'inbox' | 'leads' | 'analytics' | 'knowledge' | 'settings';

export interface NavItem {
  key: NavKey;
  icon: IconName;
  /** Roles that may open this item. Items useful even read-only stay; only
   * a "not allowed" item is hidden from the rail and the "More" page. */
  roles: Role[];
}

/** One source of truth for the top-level menu. */
export const NAV: NavItem[] = [
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
  {
    key: 'leads',
    icon: 'target',
    roles: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
  },
  { key: 'analytics', icon: 'chart', roles: ['OWNER', 'ADMIN'] },
  {
    key: 'knowledge',
    icon: 'book',
    roles: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
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
