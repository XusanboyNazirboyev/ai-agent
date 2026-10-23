import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { CrmConnector } from '../connectors/interfaces/crm-connector.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { PrismaService } from '../persistence/prisma.service.js';

export const MAX_LEAD_SYNC_ATTEMPTS = 8;

/** Backoff between CRM attempts: 1 min doubling, capped at 1 hour. */
export function leadRetryDelayMs(attempts: number): number {
  return Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Pushes local leads to the tenant's CRM through the connector's
 * `createLead` capability. Honest outcomes only:
 *  - no active connector with `createLead`  -> NOT_REQUIRED (the local lead
 *    stays; nothing claims the CRM has it);
 *  - success -> SYNCED with the CRM id;
 *  - failure -> FAILED with the error code, attempts and the next retry time,
 *    retried by the periodic scan up to MAX_LEAD_SYNC_ATTEMPTS.
 * The local row is never deleted or hidden by a CRM failure.
 */
@Injectable()
export class LeadSyncService {
  private readonly logger = new Logger(LeadSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: TenantConnectorLoader,
  ) {}

  private async connectorFor(
    tenantId: string,
  ): Promise<CrmConnector | undefined> {
    const rows = await this.prisma.tenantConnector.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) {
      try {
        const connector = this.loader.create(row);
        if (
          connector.capabilities.createLead &&
          typeof connector.createLead === 'function'
        )
          return connector;
      } catch {
        // An unusable connector config is skipped, like in the agent.
      }
    }
    return undefined;
  }

  async sync(
    tenantId: string,
    leadId: string,
  ): Promise<'SYNCED' | 'NOT_REQUIRED' | 'FAILED' | 'SKIPPED'> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenantId },
      include: { contact: { select: { name: true, phone: true } } },
    });
    if (!lead || lead.crmSyncStatus === 'SYNCED') return 'SKIPPED';
    const connector = await this.connectorFor(tenantId);
    if (!connector?.createLead) {
      await this.prisma.lead.updateMany({
        where: { id: lead.id, tenantId, crmSyncStatus: { not: 'SYNCED' } },
        data: {
          crmSyncStatus: 'NOT_REQUIRED',
          lastErrorCode: 'NO_CRM_CAPABILITY',
          nextAttemptAt: null,
        },
      });
      return 'NOT_REQUIRED';
    }
    try {
      const { crmLeadId } = await connector.createLead({
        contact: {
          ...(lead.contact.name ? { name: lead.contact.name } : {}),
          ...(lead.contact.phone ? { phone: lead.contact.phone } : {}),
        },
        summary: lead.summary,
        slots: (lead.requirements ?? {}) as Record<string, unknown>,
        score: lead.score,
        reasonCodes: lead.reasonCodes,
      });
      await this.prisma.lead.updateMany({
        where: { id: lead.id, tenantId },
        data: {
          crmSyncStatus: 'SYNCED',
          crmLeadId,
          lastErrorCode: null,
          nextAttemptAt: null,
          attempts: { increment: 1 },
        },
      });
      return 'SYNCED';
    } catch (error) {
      const attempts = lead.attempts + 1;
      const code =
        typeof (error as { code?: unknown }).code === 'string'
          ? String((error as { code: string }).code).slice(0, 100)
          : (error as Error).name.slice(0, 100);
      await this.prisma.lead.updateMany({
        where: { id: lead.id, tenantId },
        data: {
          crmSyncStatus: 'FAILED',
          lastErrorCode: code,
          attempts,
          nextAttemptAt:
            attempts >= MAX_LEAD_SYNC_ATTEMPTS
              ? null
              : new Date(Date.now() + leadRetryDelayMs(attempts)),
        },
      });
      this.logger.warn(
        JSON.stringify({
          event: 'lead.crm_sync_failed',
          tenant: tenantId,
          lead: lead.id,
          code,
          attempts,
        }),
      );
      return 'FAILED';
    }
  }

  /** Re-queues FAILED leads whose retry time has come (bounded attempts). */
  async scanDue(now: Date, limit = 25): Promise<number> {
    const due = await this.prisma.lead.findMany({
      where: {
        crmSyncStatus: 'FAILED',
        attempts: { lt: MAX_LEAD_SYNC_ATTEMPTS },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
      select: { id: true, tenantId: true, attempts: true },
    });
    let queued = 0;
    for (const lead of due) {
      const claimed = await this.prisma.lead.updateMany({
        where: {
          id: lead.id,
          tenantId: lead.tenantId,
          crmSyncStatus: 'FAILED',
          attempts: lead.attempts,
        },
        data: { crmSyncStatus: 'PENDING', nextAttemptAt: null },
      });
      if (claimed.count !== 1) continue;
      await this.prisma.outboxEvent.createMany({
        data: [
          {
            tenantId: lead.tenantId,
            type: 'crm.lead.sync',
            aggregateType: 'lead',
            aggregateId: lead.id,
            idempotencyKey: `crm.lead.sync:${lead.id}:retry:${lead.attempts}`,
            payload: { leadId: lead.id } satisfies Prisma.InputJsonObject,
          },
        ],
        skipDuplicates: true,
      });
      queued += 1;
    }
    return queued;
  }
}
