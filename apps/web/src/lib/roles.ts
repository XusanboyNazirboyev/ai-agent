import type { Role } from './types';

/** Platform console roles (ADR 047 §1). */
export type PlatformRole = 'PLATFORM_OWNER' | 'PLATFORM_SUPPORT';

/** PLATFORM_SUPPORT reads only; the API refuses its writes anyway (403). */
export function canWritePlatform(role: PlatformRole | undefined): boolean {
  return role === 'PLATFORM_OWNER';
}

/** Team page and subscription details: OWNER and ADMIN (ADR 047 §5). */
export function canManageTeam(role: Role | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export const TEAM_ROLES: readonly Role[] = [
  'OWNER',
  'ADMIN',
  'OPERATOR',
  'VIEWER',
];

/** Roles the actor may invite or grant: an ADMIN never grants OWNER. */
export function assignableRoles(actor: Role): Role[] {
  if (!canManageTeam(actor)) return [];
  return TEAM_ROLES.filter((role) => role !== 'OWNER' || actor === 'OWNER');
}

/**
 * Whether the row of `member` shows edit controls for `actor`. Mirrors the
 * API rules (nobody edits themselves; an ADMIN never edits an OWNER); the
 * last-owner rule needs the whole team and is left to the API's answer.
 */
export function canEditMember(
  actor: { id: string; role: Role },
  member: { id: string; role: Role },
): boolean {
  if (!canManageTeam(actor.role)) return false;
  if (actor.id === member.id) return false;
  return member.role !== 'OWNER' || actor.role === 'OWNER';
}
