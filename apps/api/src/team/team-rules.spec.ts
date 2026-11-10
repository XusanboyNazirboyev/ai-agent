import { describe, expect, it } from 'vitest';
import {
  checkInvite,
  checkOperatorChange,
  maxOperatorsOf,
  type OperatorChange,
} from './team-rules.js';

function change(overrides: Partial<OperatorChange>): OperatorChange {
  return {
    actor: { id: 'a', role: 'OWNER' },
    target: { id: 'b', role: 'OPERATOR', isActive: true },
    change: { role: 'ADMIN' },
    activeOwners: 1,
    ...overrides,
  };
}

describe('team rules (ADR 047 §5)', () => {
  it('only OWNER and ADMIN manage the team', () => {
    expect(checkInvite('OPERATOR', 'VIEWER')).toBe('FORBIDDEN');
    expect(checkInvite('VIEWER', 'VIEWER')).toBe('FORBIDDEN');
    expect(checkInvite('ADMIN', 'OPERATOR')).toBeNull();
    expect(
      checkOperatorChange(change({ actor: { id: 'a', role: 'OPERATOR' } })),
    ).toBe('FORBIDDEN');
  });

  it('an ADMIN can neither grant nor remove OWNER', () => {
    expect(checkInvite('ADMIN', 'OWNER')).toBe('OWNER_ONLY');
    expect(checkInvite('OWNER', 'OWNER')).toBeNull();
    const admin = { id: 'a', role: 'ADMIN' as const };
    expect(
      checkOperatorChange(change({ actor: admin, change: { role: 'OWNER' } })),
    ).toBe('OWNER_ONLY');
    expect(
      checkOperatorChange(
        change({
          actor: admin,
          target: { id: 'b', role: 'OWNER', isActive: true },
          change: { isActive: false },
          activeOwners: 3,
        }),
      ),
    ).toBe('OWNER_ONLY');
  });

  it('nobody edits themselves', () => {
    expect(
      checkOperatorChange(
        change({
          actor: { id: 'a', role: 'OWNER' },
          target: { id: 'a', role: 'OWNER', isActive: true },
          activeOwners: 2,
        }),
      ),
    ).toBe('SELF_EDIT');
  });

  it('protects the last active OWNER, not one of several', () => {
    const owner = { id: 'b', role: 'OWNER' as const, isActive: true };
    expect(
      checkOperatorChange(
        change({ target: owner, change: { role: 'ADMIN' }, activeOwners: 1 }),
      ),
    ).toBe('LAST_OWNER');
    expect(
      checkOperatorChange(
        change({ target: owner, change: { isActive: false }, activeOwners: 1 }),
      ),
    ).toBe('LAST_OWNER');
    expect(
      checkOperatorChange(
        change({ target: owner, change: { isActive: false }, activeOwners: 2 }),
      ),
    ).toBeNull();
    // Reactivating or keeping OWNER never trips the rule.
    expect(
      checkOperatorChange(
        change({ target: owner, change: { role: 'OWNER' }, activeOwners: 1 }),
      ),
    ).toBeNull();
  });

  it('reads maxOperators from plan limits', () => {
    expect(maxOperatorsOf({ maxOperators: 3 })).toBe(3);
    expect(maxOperatorsOf({ maxOperators: 0 })).toBe(0);
    expect(maxOperatorsOf({ maxOperators: '3' })).toBeUndefined();
    expect(maxOperatorsOf({ maxOperators: 2.5 })).toBeUndefined();
    expect(maxOperatorsOf({})).toBeUndefined();
    expect(maxOperatorsOf(null)).toBeUndefined();
  });
});
