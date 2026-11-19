import { usdToNano } from '../core/llm/pricing.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Limits a subscription plan may set (ADR 047, `SubscriptionPlan.limits`).
 * A missing key means the plan does not limit that resource.
 */
export interface PlanLimits {
  readonly maxOperators?: number;
  readonly maxChannelAccounts?: number;
  readonly monthlyLlmBudgetUsd?: number;
  /** ADR 080: new leads per calendar month (tenant time zone); warned, never blocked. */
  readonly monthlyNewLeads?: number;
}

/** Subscription states whose plan limits apply. */
export const OPEN_SUBSCRIPTION_STATES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
] as const;

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeAmount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Reads the stored JSON; anything malformed counts as "no limit". */
export function planLimitsOf(raw: unknown): PlanLimits {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const maxOperators = nonNegativeInt(record.maxOperators);
  const maxChannelAccounts = nonNegativeInt(record.maxChannelAccounts);
  const monthlyLlmBudgetUsd = nonNegativeAmount(record.monthlyLlmBudgetUsd);
  const monthlyNewLeads =
    typeof record.monthlyNewLeads === 'number' &&
    Number.isInteger(record.monthlyNewLeads) &&
    record.monthlyNewLeads > 0
      ? record.monthlyNewLeads
      : undefined;
  return {
    ...(monthlyNewLeads !== undefined ? { monthlyNewLeads } : {}),
    ...(maxOperators !== undefined ? { maxOperators } : {}),
    ...(maxChannelAccounts !== undefined ? { maxChannelAccounts } : {}),
    ...(monthlyLlmBudgetUsd !== undefined ? { monthlyLlmBudgetUsd } : {}),
  };
}

type SubscriptionDb = Pick<Prisma.TransactionClient, 'tenantSubscription'>;

/** Limits of the tenant's open subscription; none without one. */
export async function openPlanLimits(
  db: SubscriptionDb,
  tenantId: string,
): Promise<PlanLimits> {
  const open = await db.tenantSubscription.findFirst({
    where: { tenantId, status: { in: [...OPEN_SUBSCRIPTION_STATES] } },
    select: { plan: { select: { limits: true } } },
  });
  return open ? planLimitsOf(open.plan.limits) : {};
}

/**
 * The tenant's monthly AI budget in nano-USD: the plan's when it sets one
 * (0 means no AI spending), otherwise the server default
 * `LLM_TENANT_MONTHLY_BUDGET_USD`; undefined means no cap.
 */
export function monthlyLlmBudgetNano(
  plan: PlanLimits,
  serverDefaultUsd: string | undefined,
): number | undefined {
  if (plan.monthlyLlmBudgetUsd !== undefined)
    return Math.round(plan.monthlyLlmBudgetUsd * 1_000_000_000);
  return serverDefaultUsd ? usdToNano(serverDefaultUsd) : undefined;
}
