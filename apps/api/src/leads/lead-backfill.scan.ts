import { Injectable, Logger } from '@nestjs/common';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { LeadService } from './lead.service.js';
import { MANUAL_CHANNEL_TYPE } from './manual-lead-rules.js';

/** Written once per tenant when its existing conversations have leads. */
export const LEAD_BACKFILL_ACTION = 'lead.backfill_customers';

const BATCH = 100;
const TENANTS_PER_RUN = 20;

/**
 * Owner decision 2026-11-17: every customer who writes is a lead. New
 * messages create the lead at intake; this scan gives the conversations that
 * existed before that rule a lead, once per tenant (a marker audit event
 * stops it). A conversation counts when the customer wrote a direct message
 * that is not only a Telegram `/start`; public comments do not count. A
 * conversation whose lead was deleted for good is skipped when the deletion
 * recorded its conversation (deletions before this change did not).
 */
@Injectable()
export class LeadBackfillScan implements ScheduledScan {
  private readonly logger = new Logger(LeadBackfillScan.name);
  private finished = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadService,
  ) {}

  async scanDue(): Promise<number> {
    if (this.finished) return 0;
    const tenants = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id::text AS id FROM tenants t
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_events a
        WHERE a.tenant_id = t.id AND a.action = ${LEAD_BACKFILL_ACTION})
      ORDER BY t.created_at ASC
      LIMIT ${TENANTS_PER_RUN}`;
    if (tenants.length === 0) {
      this.finished = true;
      return 0;
    }
    let created = 0;
    for (const { id } of tenants) created += await this.backfillTenant(id);
    return created;
  }

  /** Leads for one tenant's conversations; the marker once none are left. */
  async backfillTenant(tenantId: string): Promise<number> {
    const missing = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT c.id::text AS id FROM conversations c
      JOIN channel_accounts ca ON ca.id = c.channel_account_id
      WHERE c.tenant_id = ${tenantId}::uuid
        AND ca.channel_type <> ${MANUAL_CHANNEL_TYPE}
        AND NOT EXISTS (
          SELECT 1 FROM leads l
          WHERE l.tenant_id = c.tenant_id
            AND l.idempotency_key = 'lead:' || c.id::text)
        AND NOT EXISTS (
          SELECT 1 FROM audit_events a
          WHERE a.tenant_id = c.tenant_id AND a.action = 'lead.deleted'
            AND a.safe_input_summary ->> 'conversationId' = c.id::text)
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
            AND m.direction = 'INBOUND' AND m.author_type = 'CUSTOMER'
            AND m.type <> 'COMMENT'
            AND (m.type <> 'TEXT'
              OR btrim(coalesce(m.text, '')) !~ '^/start(@[A-Za-z0-9_]{1,64})?(\\s+\\S{1,64})?$'))
      ORDER BY c.created_at ASC
      LIMIT ${BATCH}`;
    let created = 0;
    for (const { id } of missing) {
      const made = await this.prisma.$transaction(async (tx) => {
        // The same lock as intake and the agent turn: one writer per chat.
        await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agentcore:${tenantId}:${id}`}, 0))) AS lock_result`;
        const before = await tx.lead.count({
          where: { tenantId, idempotencyKey: `lead:${id}` },
        });
        await this.leads.ensureForCustomerMessage(tx, {
          tenantId,
          conversationId: id,
        });
        const after = await tx.lead.count({
          where: { tenantId, idempotencyKey: `lead:${id}` },
        });
        return after - before;
      });
      created += made;
    }
    if (missing.length < BATCH) {
      await this.prisma.auditEvent.createMany({
        data: [
          {
            tenantId,
            actorType: 'SYSTEM',
            action: LEAD_BACKFILL_ACTION,
            entityType: 'tenant',
            entityId: tenantId,
            safeInputSummary: { created },
            idempotencyKey: `${LEAD_BACKFILL_ACTION}:${tenantId}`,
          },
        ],
        // Two API processes may finish the same tenant.
        skipDuplicates: true,
      });
    }
    if (created > 0)
      this.logger.log(
        JSON.stringify({ event: 'lead.backfill', tenantId, created }),
      );
    return created;
  }
}
