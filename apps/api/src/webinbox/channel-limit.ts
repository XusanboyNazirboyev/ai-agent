import type { Prisma } from '../generated/prisma/client.js';
import {
  effectiveChannelAccountLimit,
  OPEN_SUBSCRIPTION_STATES,
  planLimitsOf,
} from '../access/plan-limits.js';
import { MANUAL_CHANNEL_TYPE } from '../leads/manual-lead-rules.js';

type CountDb = Pick<
  Prisma.TransactionClient,
  'tenantSubscription' | 'channelAccount'
>;

interface TransactionDb {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/**
 * Whether one more ACTIVE channel account fits the plan's
 * `maxChannelAccounts`. The account itself is not counted, so enabling an
 * account that is already ACTIVE always fits. Trial and missing plan limits
 * include one account; a paid plan must explicitly grant more.
 */
export async function channelSlotFree(
  db: CountDb,
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  const subscription = await db.tenantSubscription.findFirst({
    where: {
      tenantId,
      status: { in: [...OPEN_SUBSCRIPTION_STATES] },
    },
    select: { status: true, plan: { select: { limits: true } } },
  });
  const maxChannelAccounts = effectiveChannelAccountLimit(
    subscription?.status,
    subscription ? planLimitsOf(subscription.plan.limits) : {},
  );
  const active = await db.channelAccount.count({
    where: {
      tenantId,
      status: 'ACTIVE',
      id: { not: accountId },
      channelType: { not: MANUAL_CHANNEL_TYPE },
    },
  });
  return active < maxChannelAccounts;
}

/**
 * Sets the account ACTIVE if the plan allows it. The check and the update
 * run under a per-tenant lock, so two accounts enabled at the same moment
 * cannot both take the last slot. Returns false (nothing changed) when the
 * limit is reached.
 */
export async function activateChannelAccount(
  db: TransactionDb,
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agentcore:channels:${tenantId}`}, 0))) AS lock_result`;
    if (!(await channelSlotFree(tx, tenantId, accountId))) return false;
    await tx.channelAccount.updateMany({
      where: { id: accountId, tenantId },
      data: { status: 'ACTIVE' },
    });
    return true;
  });
}
