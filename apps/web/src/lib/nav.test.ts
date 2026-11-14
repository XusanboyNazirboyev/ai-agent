import { describe, expect, it } from 'vitest';
import type { NavKey } from './nav';
import type { Role } from './types';
import { NAV, visibleNav } from './nav';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];
const FULL: NavKey[] = [
  'today',
  'inbox',
  'leads',
  'analytics',
  'knowledge',
  'settings',
];
const WITHOUT_ANALYTICS: NavKey[] = [
  'today',
  'inbox',
  'leads',
  'knowledge',
  'settings',
];

describe('visibleNav', () => {
  it('shows the complete menu to an owner and an administrator', () => {
    expect(visibleNav('OWNER')).toEqual(FULL);
    expect(visibleNav('ADMIN')).toEqual(FULL);
  });

  it('hides analytics from an operator and a viewer', () => {
    expect(visibleNav('OPERATOR')).toEqual(WITHOUT_ANALYTICS);
    expect(visibleNav('VIEWER')).toEqual(WITHOUT_ANALYTICS);
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
