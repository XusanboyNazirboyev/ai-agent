import type { Prisma } from '../generated/prisma/client.js';
import { moveLeadToStage } from './lead-stage-move.js';

type Tx = Pick<Prisma.TransactionClient, 'lead' | 'outboxEvent'>;
type StatusTx = Pick<
  Prisma.TransactionClient,
  'lead' | 'leadStage' | 'auditEvent'
>;

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
      // ADR 062: an archived lead is frozen (the conversation has "no lead").
      where: { tenantId, conversationId, archivedAt: null },
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

/**
 * Deprecated route (ADR 058 decision 9): the stage is the only thing an
 * operator sets. WON/LOST move the lead to the first stage of that kind in its
 * pipeline when one exists; otherwise only the status is set, as before.
 */
export async function setOperatorLeadStatus(
  tx: StatusTx,
  tenantId: string,
  lead: { id: string },
  status: OperatorLeadStatus,
  lostReason: string | null = null,
  actorId?: string,
): Promise<void> {
  const current = await tx.lead.findFirst({
    where: { tenantId, id: lead.id },
    select: {
      pipelineId: true,
      pipelineStageId: true,
      pipelineStage: { select: { kind: true } },
    },
  });
  const wantedKind =
    status === 'WON' ? 'WON' : status === 'LOST' ? 'LOST' : 'OPEN';
  if (current && current.pipelineStage?.kind !== wantedKind) {
    const target = await tx.leadStage.findFirst({
      where: {
        tenantId,
        pipelineId: current.pipelineId,
        kind: wantedKind,
        archivedAt: null,
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (target)
      await moveLeadToStage(tx, {
        tenantId,
        leadId: lead.id,
        stageId: target.id,
        actor: 'OPERATOR',
        actorId,
        lostReason,
      });
  }
  // ADR 057: LOST carries its reason; leaving LOST clears it.
  await tx.lead.updateMany({
    where: { tenantId, id: lead.id },
    data: { status, lostReason: status === 'LOST' ? lostReason : null },
  });
}
