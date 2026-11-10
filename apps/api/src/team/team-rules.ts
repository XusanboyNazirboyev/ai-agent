/**
 * Team management rules (ADR 047 §5), enforced in the API: only OWNER and
 * ADMIN manage the team; an ADMIN can neither grant nor remove OWNER; the
 * last active OWNER cannot be deactivated or demoted; nobody edits their own
 * role or activity.
 */
export type TeamRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export type TeamRuleViolation =
  'FORBIDDEN' | 'SELF_EDIT' | 'OWNER_ONLY' | 'LAST_OWNER';

export const TEAM_ROLES: readonly TeamRole[] = [
  'OWNER',
  'ADMIN',
  'OPERATOR',
  'VIEWER',
];

export function canManageTeam(role: TeamRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** May `actor` invite (or revoke an invite of) someone with `role`? */
export function checkInvite(
  actor: TeamRole,
  role: TeamRole,
): TeamRuleViolation | null {
  if (!canManageTeam(actor)) return 'FORBIDDEN';
  if (role === 'OWNER' && actor !== 'OWNER') return 'OWNER_ONLY';
  return null;
}

export interface OperatorChange {
  readonly actor: { readonly id: string; readonly role: TeamRole };
  readonly target: {
    readonly id: string;
    readonly role: TeamRole;
    readonly isActive: boolean;
  };
  readonly change: { readonly role?: TeamRole; readonly isActive?: boolean };
  /** Active OWNERs of the tenant, the target included. */
  readonly activeOwners: number;
}

export function checkOperatorChange(
  input: OperatorChange,
): TeamRuleViolation | null {
  const { actor, target, change } = input;
  if (!canManageTeam(actor.role)) return 'FORBIDDEN';
  if (actor.id === target.id) return 'SELF_EDIT';
  if (
    actor.role !== 'OWNER' &&
    (target.role === 'OWNER' || change.role === 'OWNER')
  )
    return 'OWNER_ONLY';
  const losesOwner =
    target.role === 'OWNER' &&
    target.isActive &&
    ((change.role !== undefined && change.role !== 'OWNER') ||
      change.isActive === false);
  if (losesOwner && input.activeOwners <= 1) return 'LAST_OWNER';
  return null;
}

/** `maxOperators` from a plan's limits JSON; undefined means no limit. */
export function maxOperatorsOf(limits: unknown): number | undefined {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits))
    return undefined;
  const value = (limits as Record<string, unknown>).maxOperators;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
