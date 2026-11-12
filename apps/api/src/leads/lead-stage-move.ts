import type { Prisma } from '../generated/prisma/client.js';
import { lostReasonRequired, notFound } from '../pipelines/pipeline-errors.js';

type Tx = Pick<Prisma.TransactionClient, 'lead' | 'leadStage' | 'auditEvent'>;

export type StageActor = 'AGENT' | 'OPERATOR';

export interface MoveLeadInput {
  readonly tenantId: string;
  readonly leadId: string;
  readonly stageId: string;
  readonly actor: StageActor;
  /** Audit actor id of the operator (ignored for the agent). */
  readonly actorId?: string;
  readonly lostReason?: string | null;
  readonly reasonCodes?: readonly string[];
}

export interface MoveLeadResult {
  readonly id: string;
  readonly pipelineId: string;
  readonly pipelineStageId: string;
  readonly status: string;
  readonly moved: boolean;
}

/**
 * The single path that changes a lead's stage (ADR 058 decision 1). Stage and
 * status never disagree: a WON stage sets status WON, a LOST stage sets LOST
 * (and needs a reason), leaving a closed stage for an OPEN one sets
 * IN_PROGRESS and clears the reason. A move to another pipeline's stage moves
 * the lead there. Records who set the stage (decision 4), clears any pending
 * suggestion and writes the `lead.stage.moved` audit row (no customer text).
 */
export async function moveLeadToStage(
  tx: Tx,
  input: MoveLeadInput,
): Promise<MoveLeadResult> {
  const { tenantId, leadId, stageId, actor } = input;
  const [lead, stage] = await Promise.all([
    tx.lead.findFirst({
      where: { tenantId, id: leadId },
      select: {
        id: true,
        pipelineId: true,
        pipelineStageId: true,
        status: true,
        lostReason: true,
      },
    }),
    tx.leadStage.findFirst({
      where: {
        tenantId,
        id: stageId,
        archivedAt: null,
        pipeline: { archivedAt: null },
      },
      select: { id: true, pipelineId: true, kind: true },
    }),
  ]);
  if (!lead || !stage) throw notFound();
  const reason = input.lostReason?.trim() || null;
  const closed = lead.status === 'WON' || lead.status === 'LOST';
  const data: Prisma.LeadUncheckedUpdateManyInput = {};
  if (stage.kind === 'WON') {
    data.status = 'WON';
    data.lostReason = null;
  } else if (stage.kind === 'LOST') {
    const effective =
      reason ?? (lead.status === 'LOST' ? lead.lostReason : null);
    if (!effective) throw lostReasonRequired();
    data.status = 'LOST';
    data.lostReason = effective;
  } else if (closed) {
    data.status = 'IN_PROGRESS';
    data.lostReason = null;
  }
  const sameStage = lead.pipelineStageId === stage.id;
  const statusChanged =
    data.status !== undefined &&
    (data.status !== lead.status || data.lostReason !== lead.lostReason);
  if (sameStage && !statusChanged) {
    return {
      id: lead.id,
      pipelineId: lead.pipelineId,
      pipelineStageId: stage.id,
      status: lead.status,
      moved: false,
    };
  }
  // Pipeline and stage change in one update (the composite FK keeps them
  // consistent at the database level).
  await tx.lead.updateMany({
    where: { tenantId, id: lead.id },
    data: {
      ...data,
      pipelineId: stage.pipelineId,
      pipelineStageId: stage.id,
      stageSetBy: actor,
      stageSetAt: new Date(),
      suggestedStageId: null,
      suggestedReasonCodes: [],
    },
  });
  await tx.auditEvent.create({
    data: {
      tenantId,
      actorType: actor === 'AGENT' ? 'SYSTEM' : 'OPERATOR',
      actorId: actor === 'OPERATOR' ? (input.actorId ?? null) : null,
      action: 'lead.stage.moved',
      entityType: 'lead',
      entityId: lead.id,
      safeInputSummary: {
        from: lead.pipelineStageId ?? '',
        to: stage.id,
        fromPipelineId: lead.pipelineId,
        toPipelineId: stage.pipelineId,
        actor,
        reasonCodes: (input.reasonCodes ?? []).join(','),
      },
    },
  });
  return {
    id: lead.id,
    pipelineId: stage.pipelineId,
    pipelineStageId: stage.id,
    status: (data.status as string | undefined) ?? lead.status,
    moved: true,
  };
}
