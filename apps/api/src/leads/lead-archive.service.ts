import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { conflict, notFound } from '../pipelines/pipeline-errors.js';
import { ContactErasureService } from '../retention/contact-erasure.service.js';
import { isManualChannelType } from './manual-lead-rules.js';

type Tx = Prisma.TransactionClient;

export interface LeadArchiveActor {
  readonly tenantId: string;
  readonly operatorId: string;
}

interface ArchivableLead {
  id: string;
  contactId: string;
  pipelineId: string;
  pipelineStageId: string | null;
  archivedAt: Date | null;
  /** Added by hand (ADR 061): its contact is erased with it. */
  manual: boolean;
}

/** Why a lead cannot be changed: it is archived (ADR 062 decision 4). */
export const leadArchived = (): ReturnType<typeof conflict> =>
  conflict('LEAD_ARCHIVED', 'The lead is archived');

/**
 * Archive, restore and delete-for-good of a lead (ADR 062). Every call is one
 * transaction and tenant-scoped; the audit row carries ids only.
 */
@Injectable()
export class LeadArchiveService {
  private readonly erasure: ContactErasureService;

  constructor(private readonly prisma: PrismaService) {
    this.erasure = new ContactErasureService(prisma);
  }

  /** Idempotent: archiving an archived lead changes nothing. */
  async archive(actor: LeadArchiveActor, leadId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const lead = await this.find(tx, actor.tenantId, leadId);
      if (lead.archivedAt) return;
      await tx.lead.updateMany({
        where: { tenantId: actor.tenantId, id: leadId, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      await this.audit(tx, actor, 'lead.archived', lead);
    });
  }

  /** Idempotent: restoring an active lead changes nothing. */
  async restore(actor: LeadArchiveActor, leadId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const lead = await this.find(tx, actor.tenantId, leadId);
      if (!lead.archivedAt) return;
      await tx.lead.updateMany({
        where: {
          tenantId: actor.tenantId,
          id: leadId,
          archivedAt: { not: null },
        },
        data: { archivedAt: null },
      });
      await this.audit(tx, actor, 'lead.restored', lead);
    });
  }

  /**
   * Only an archived lead. A lead added by hand also has its contact erased
   * (ADR 062 decision 6); an agent-created lead keeps its conversation.
   */
  async deleteForGood(actor: LeadArchiveActor, leadId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const lead = await this.find(tx, actor.tenantId, leadId);
      if (!lead.archivedAt)
        throw conflict('LEAD_NOT_ARCHIVED', 'Archive the lead first');
      await tx.leadTag.deleteMany({
        where: { tenantId: actor.tenantId, leadId },
      });
      await tx.lead.deleteMany({
        where: { tenantId: actor.tenantId, id: leadId },
      });
      await this.audit(tx, actor, 'lead.deleted', lead);
      if (lead.manual)
        await this.erasure.eraseInTransaction(
          tx,
          actor.tenantId,
          lead.contactId,
          actor.operatorId,
        );
    });
  }

  private async find(
    tx: Tx,
    tenantId: string,
    leadId: string,
  ): Promise<ArchivableLead> {
    const row = await tx.lead.findFirst({
      where: { tenantId, id: leadId },
      select: {
        id: true,
        contactId: true,
        pipelineId: true,
        pipelineStageId: true,
        archivedAt: true,
        conversation: {
          select: { channelAccount: { select: { channelType: true } } },
        },
      },
    });
    if (!row) throw notFound();
    return {
      id: row.id,
      contactId: row.contactId,
      pipelineId: row.pipelineId,
      pipelineStageId: row.pipelineStageId,
      archivedAt: row.archivedAt,
      manual: isManualChannelType(row.conversation.channelAccount.channelType),
    };
  }

  private async audit(
    tx: Tx,
    actor: LeadArchiveActor,
    action: 'lead.archived' | 'lead.restored' | 'lead.deleted',
    lead: { id: string; pipelineId: string; pipelineStageId: string | null },
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId: actor.tenantId,
        actorType: 'OPERATOR',
        actorId: actor.operatorId,
        action,
        entityType: 'lead',
        entityId: lead.id,
        // Ids only: never the name, phone or note.
        safeInputSummary: {
          pipelineId: lead.pipelineId,
          stageId: lead.pipelineStageId,
        },
      },
    });
  }
}
