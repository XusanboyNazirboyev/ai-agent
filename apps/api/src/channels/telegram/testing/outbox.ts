import type { PrismaClient } from '../../../generated/prisma/client.js';
import { OUTBOX_MAX_ATTEMPTS } from '../telegram-queue.runtime.js';

/**
 * Tests that drive TelegramProcessor directly (no relay) leave their tenants'
 * outbox rows unpublished. The relay publishes due rows of every tenant,
 * oldest first, so in a shared test database a later test's relay would work
 * through them before its own events. A finished test therefore marks its
 * own tenants' undelivered rows as dead letters (FAILED at the attempt limit,
 * never re-queued). Tenant-scoped; nothing is deleted.
 */
export async function retireOutbox(
  db: PrismaClient,
  tenantIds: string[],
): Promise<number> {
  if (tenantIds.length === 0) return 0;
  const { count } = await db.outboxEvent.updateMany({
    where: {
      tenantId: { in: tenantIds },
      status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
    },
    data: { status: 'FAILED', attempts: OUTBOX_MAX_ATTEMPTS },
  });
  return count;
}

/** What the relay does once a worker has the event: the row is published. */
export async function markPublished(
  db: PrismaClient,
  tenantId: string,
  outboxId: string,
): Promise<void> {
  await db.outboxEvent.updateMany({
    where: { id: outboxId, tenantId },
    data: { status: 'SENT' },
  });
}

/**
 * For tests that run the real relay (TelegramQueueRuntime): the relay works
 * through due rows of every tenant, oldest first, 25 per poll. Rows left by
 * earlier runs in the shared test database would delay the test's own event
 * past its deadline, so rows of all OTHER tenants are retired first (status
 * update only, nothing deleted; refuses any database but agentcore_test).
 */
export async function retireForeignBacklog(
  db: PrismaClient,
  keepTenantIds: string[],
): Promise<number> {
  const [{ name }] = await db.$queryRaw<
    { name: string }[]
  >`select current_database() as name`;
  if (name !== 'agentcore_test')
    throw new Error('retireForeignBacklog only runs on agentcore_test');
  const { count } = await db.outboxEvent.updateMany({
    where: {
      tenantId: { notIn: keepTenantIds },
      status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
    },
    data: { status: 'FAILED', attempts: OUTBOX_MAX_ATTEMPTS },
  });
  return count;
}
