import type { Prisma } from '../generated/prisma/client.js';

type Tx = Pick<Prisma.TransactionClient, 'lead' | 'outboxEvent'>;

export type OperatorLeadScore = 'HOT' | 'WARM' | 'COLD' | null;
export type OperatorLeadStatus = 'NEW' | 'IN_PROGRESS' | 'WON' | 'LOST';

/** The conversation's latest lead, or undefined when it has none. */
export async function latestLead(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<{ id: string; crmSyncStatus: string } | undefined> {
  return (
    (await tx.lead.findFirst({
      where: { tenantId, conversationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, crmSyncStatus: true },
    })) ?? undefined
  );
}

/**
 * An operator sets a lead's score (ADR 037); `null` returns it to automatic
 * scoring from the next customer turn. A change the CRM can still take is
 * queued for it.
 */
export async function setOperatorLeadScore(
  tx: Tx,
  tenantId: string,
  lead: { id: string; crmSyncStatus: string },
  score: OperatorLeadScore,
): Promise<void> {
  await tx.lead.updateMany({
    where: { tenantId, id: lead.id },
    data:
      score === null
        ? { scoreSetByOperator: false }
        : { score, scoreSetByOperator: true },
  });
  if (score !== null && lead.crmSyncStatus !== 'SYNCED')
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          type: 'crm.lead.sync',
          aggregateType: 'lead',
          aggregateId: lead.id,
          idempotencyKey: `crm.lead.sync:${lead.id}:operator-score:${score}:${Date.now()}`,
          payload: { leadId: lead.id },
        },
      ],
      skipDuplicates: true,
    });
}

export async function setOperatorLeadStatus(
  tx: Tx,
  tenantId: string,
  lead: { id: string },
  status: OperatorLeadStatus,
): Promise<void> {
  await tx.lead.updateMany({
    where: { tenantId, id: lead.id },
    data: { status },
  });
}
