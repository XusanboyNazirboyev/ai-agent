import type { Prisma } from '../generated/prisma/client.js';
import { openPlanLimits } from '../access/plan-limits.js';
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
 * account that is already ACTIVE always fits. No open subscription or no
 * limit on the plan means no limit (as for operator seats).
 */
export async function channelSlotFree(
  db: CountDb,
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  const { maxChannelAccounts } = await openPlanLimits(db, tenantId);
  if (maxChannelAccounts === undefined) return true;
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
