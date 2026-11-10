/**
 * What a tenant may do right now (ADR 047 §3). Pure: the service loads the
 * rows, this decides. `ok` is the only state in which the bot answers.
 */
export type AccessState =
  'ok' | 'SUSPENDED' | 'ARCHIVED' | 'SUBSCRIPTION_EXPIRED';

export type SubscriptionStatusName =
  'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'EXPIRED' | 'CANCELED';

export interface AccessInput {
  readonly tenantStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  /** `config.billing.required` of the tenant (set by the console on creation). */
  readonly billingRequired: boolean;
  /** The tenant's most recent subscription row, open or not. */
  readonly latest: {
    readonly status: SubscriptionStatusName;
    readonly currentPeriodEnd: Date;
    readonly graceUntil: Date | null;
  } | null;
}

export interface TenantAccess {
  readonly state: AccessState;
  readonly subscriptionStatus: SubscriptionStatusName | null;
  readonly periodEnd: Date | null;
  readonly graceUntil: Date | null;
}

export const OPEN_SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
] as const satisfies readonly SubscriptionStatusName[];

export function decideAccess(input: AccessInput, now: Date): TenantAccess {
  const latest = input.latest;
  const base = {
    subscriptionStatus: latest?.status ?? null,
    periodEnd: latest?.currentPeriodEnd ?? null,
    graceUntil: latest?.graceUntil ?? null,
  };
  if (input.tenantStatus === 'SUSPENDED')
    return { ...base, state: 'SUSPENDED' };
  if (input.tenantStatus === 'ARCHIVED') return { ...base, state: 'ARCHIVED' };
  if (!latest)
    return {
      ...base,
      state: input.billingRequired ? 'SUBSCRIPTION_EXPIRED' : 'ok',
    };
  switch (latest.status) {
    case 'TRIAL':
    case 'ACTIVE':
      // Past its end the daily scan moves it to PAST_DUE with a grace period;
      // until it runs the tenant keeps working.
      return { ...base, state: 'ok' };
    case 'PAST_DUE':
      return {
        ...base,
        state:
          latest.graceUntil && latest.graceUntil <= now
            ? 'SUBSCRIPTION_EXPIRED'
            : 'ok',
      };
    case 'EXPIRED':
    case 'CANCELED':
      // A tenant that has been under a subscription stays under billing.
      return { ...base, state: 'SUBSCRIPTION_EXPIRED' };
  }
}

/** Reads `config.billing.required` from a tenant's JSON config. */
export function billingRequired(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    return false;
  const billing = (config as Record<string, unknown>).billing;
  if (!billing || typeof billing !== 'object' || Array.isArray(billing))
    return false;
  return (billing as Record<string, unknown>).required === true;
}
