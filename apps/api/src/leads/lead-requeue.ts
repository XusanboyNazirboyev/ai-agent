import type { Prisma } from '../generated/prisma/client.js';

type Db = Pick<Prisma.TransactionClient, 'lead' | 'outboxEvent'>;

/**
 * Leads kept local because no CRM could take them (`NOT_REQUIRED`) are queued
 * for sync again, e.g. right after a CRM is connected (ADR 037). Returns how
 * many were queued; at most `limit`, newest first.
 */
export async function requeueLocalLeads(
  db: Db,
  tenantId: string,
  reason: string,
  limit = 500,
): Promise<number> {
  const leads = await db.lead.findMany({
    where: { tenantId, crmSyncStatus: 'NOT_REQUIRED' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true },
  });
  if (leads.length === 0) return 0;
  const ids = leads.map((lead) => lead.id);
  await db.lead.updateMany({
    where: { tenantId, id: { in: ids }, crmSyncStatus: 'NOT_REQUIRED' },
    data: { crmSyncStatus: 'PENDING', lastErrorCode: null },
  });
  const created = await db.outboxEvent.createMany({
    data: ids.map((id) => ({
      tenantId,
      type: 'crm.lead.sync',
      aggregateType: 'lead',
      aggregateId: id,
      idempotencyKey: `crm.lead.sync:${id}:${reason}`,
      payload: { leadId: id },
    })),
    skipDuplicates: true,
  });
  return created.count;
}
