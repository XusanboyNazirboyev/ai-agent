import type { TenantAccess } from './types';

/** How long before the period end managers are reminded (ADR 047). */
export const ENDING_SOON_DAYS = 5;

export type AccessNotice = 'expired' | 'past-due' | 'ending-soon';

/**
 * Which subscription banner to show: expired and past due for everyone;
 * "ends soon" only for people who can renew (OWNER/ADMIN), only for a
 * running subscription (no grace date yet) whose period ends within
 * ENDING_SOON_DAYS from now.
 */
export function accessNotice(
  access: TenantAccess | undefined,
  manager: boolean,
  now: number,
): AccessNotice | null {
  if (!access) return null;
  if (access.state === 'SUBSCRIPTION_EXPIRED') return 'expired';
  if (access.state !== 'ok') return null;
  if (access.graceUntil !== null) return 'past-due';
  if (!manager || access.periodEnd === null) return null;
  const end = new Date(access.periodEnd).getTime();
  return end > now && end - now <= ENDING_SOON_DAYS * 86_400_000
    ? 'ending-soon'
    : null;
}
