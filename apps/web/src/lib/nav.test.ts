import { describe, expect, it } from 'vitest';
import type { NavKey } from './nav';
import type { Role } from './types';
import { NAV, visibleNav } from './nav';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];
// Owner 2026-11-23: the AI agent comes first.
const FULL: NavKey[] = [
  'agent',
  'today',
  'inbox',
  'crm',
  'channels',
  'billing',
  'settings',
];
const WITHOUT_MANAGER_ITEMS: NavKey[] = [
  'agent',
  'today',
  'inbox',
  'crm',
  'channels',
  'settings',
];

describe('visibleNav', () => {
  it('shows the complete menu to an owner and an administrator', () => {
    expect(visibleNav('OWNER')).toEqual(FULL);
    expect(visibleNav('ADMIN')).toEqual(FULL);
  });

  it('hides billing from an operator and a viewer', () => {
    expect(visibleNav('OPERATOR')).toEqual(WITHOUT_MANAGER_ITEMS);
    expect(visibleNav('VIEWER')).toEqual(WITHOUT_MANAGER_ITEMS);
  });

  it('never returns keys outside NAV', () => {
    const keys = new Set(NAV.map((item) => item.key));
    for (const role of ROLES)
      for (const key of visibleNav(role)) expect(keys.has(key)).toBe(true);
  });

  it('keeps every nav item allowed for at least one role', () => {
    for (const item of NAV) expect(item.roles.length).toBeGreaterThan(0);
  });
});
