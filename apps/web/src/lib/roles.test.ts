import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canEditMember,
  canManageTeam,
  canWritePlatform,
} from './roles';

describe('role-based control visibility (the API stays the truth)', () => {
  it('only a platform owner sees console write controls', () => {
    expect(canWritePlatform('PLATFORM_OWNER')).toBe(true);
    expect(canWritePlatform('PLATFORM_SUPPORT')).toBe(false);
    expect(canWritePlatform(undefined)).toBe(false);
  });

  it('only OWNER and ADMIN manage the team', () => {
    expect(canManageTeam('OWNER')).toBe(true);
    expect(canManageTeam('ADMIN')).toBe(true);
    expect(canManageTeam('OPERATOR')).toBe(false);
    expect(canManageTeam('VIEWER')).toBe(false);
  });

  it('an ADMIN is never offered the OWNER role', () => {
    expect(assignableRoles('OWNER')).toEqual([
      'OWNER',
      'ADMIN',
      'OPERATOR',
      'VIEWER',
    ]);
    expect(assignableRoles('ADMIN')).toEqual(['ADMIN', 'OPERATOR', 'VIEWER']);
    expect(assignableRoles('OPERATOR')).toEqual([]);
  });

  it('hides edit controls on oneself and, for an ADMIN, on owners', () => {
    const owner = { id: 'o', role: 'OWNER' as const };
    const admin = { id: 'a', role: 'ADMIN' as const };
    const operator = { id: 'p', role: 'OPERATOR' as const };
    expect(canEditMember(owner, owner)).toBe(false);
    expect(canEditMember(owner, admin)).toBe(true);
    expect(canEditMember(admin, owner)).toBe(false);
    expect(canEditMember(admin, operator)).toBe(true);
    expect(canEditMember(operator, { id: 'v', role: 'VIEWER' })).toBe(false);
  });
});
