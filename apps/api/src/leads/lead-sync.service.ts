import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { CrmConnector } from '../connectors/interfaces/crm-connector.js';
import { writeExecutionOf } from '../connectors/interfaces/errors.js';
import {
  ConnectorOperations,
  type ClaimedOperation,
  type OperationRef,
} from '../connectors/operations/connector-operations.js';
import {
  afterFailure,
  beforeAttempt,
} from '../connectors/operations/write-policy.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { PrismaService } from '../persistence/prisma.service.js';

export const MAX_LEAD_SYNC_ATTEMPTS = 8;

/** Backoff between CRM attempts: 1 min doubling, capped at 1 hour. */
export function leadRetryDelayMs(attempts: number): number {
  return Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** Lead marker for a CRM write that may have happened and cannot be checked. */
export const CRM_OUTCOME_UNCERTAIN = 'CRM_OUTCOME_UNCERTAIN';

/**
 * Longer than any connector request deadline (max 300 s): while it runs, no
 * other worker may attempt the same write; once it expires the attempt is
 * treated as abandoned with an unknown outcome.
 */
export const LEAD_SYNC_LEASE_MS = 10 * 60_000;

export type LeadSyncResult =
  'SYNCED' | 'NOT_REQUIRED' | 'FAILED' | 'SKIPPED' | 'UNCERTAIN';

const errorCodeOf = (error: unknown): string =>
  typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code).slice(0, 100)
    : ((error as Error)?.name ?? 'UNKNOWN').slice(0, 100);

/**
 * Pushes local leads to the tenant's CRM through `createLead`. One logical
 * write per lead (a `connector_operations` row, ADR 023) with ONE idempotency
 * key for every attempt, a lease so one worker attempts at a time, and typed
 * outcomes:
 *  - no active connector with `createLead` -> NOT_REQUIRED (local lead kept);
 *  - success -> SYNCED with the CRM id (evidence);
 *  - provably not applied (validation, auth, connect failure, ...) -> retried
 *    with backoff up to MAX_LEAD_SYNC_ATTEMPTS, then FAILED;
 *  - may have been applied (timeout, lost response, crash) -> retried with the
 *    same key only if the connector deduplicates natively, looked up first if
 *    it supports lookup, otherwise UNCERTAIN: never retried automatically,
 *    resolved by a person (`resolveUncertain`).
 * The local lead is never deleted or hidden by a CRM failure.
 */
@Injectable()
export class LeadSyncService {
  private readonly logger = new Logger(LeadSyncService.name);
  private readonly operations: ConnectorOperations;

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: TenantConnectorLoader,
  ) {
    this.operations = new ConnectorOperations(prisma);
  }

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

  private ref(tenantId: string, leadId: string): OperationRef {
    return {
      tenantId,
      kind: 'createLead',
      subjectType: 'lead',
      subjectId: leadId,
    };
  }

  async sync(
    tenantId: string,
    leadId: string,
    now = new Date(),
  ): Promise<LeadSyncResult> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenantId },
      include: { contact: { select: { name: true, phone: true } } },
    });
    if (!lead || lead.crmSyncStatus === 'SYNCED') return 'SKIPPED';
    const ref = this.ref(tenantId, lead.id);
    const existing = await this.operations.find(ref);
    if (existing?.status === 'UNCERTAIN') return 'UNCERTAIN';
    // Already created (a later re-score marked the lead stale): the CRM copy
    // is not updated in v1, but it is never created twice.
    const done =
      existing &&
      ['SUCCEEDED', 'RESOLVED_SUCCEEDED'].includes(existing.status) &&
      existing.externalId
        ? existing.externalId
        : // A customer-confirmed action already created this conversation's CRM lead.
          (
            await this.prisma.actionProposal.findFirst({
              where: {
                tenantId,
                conversationId: lead.conversationId,
                operation: 'createLead',
                status: 'SUCCEEDED',
              },
              orderBy: { outcomeAt: 'desc' },
              select: { externalId: true },
            })
          )?.externalId;
    if (done) {
      await this.prisma.lead.updateMany({
        where: { id: lead.id, tenantId, crmSyncStatus: { not: 'SYNCED' } },
        data: {
          crmSyncStatus: 'SYNCED',
          crmLeadId: done,
          lastErrorCode: null,
          nextAttemptAt: null,
        },
      });
      return 'SKIPPED';
    }
    if (existing && ['FAILED', 'RESOLVED_FAILED'].includes(existing.status))
      return 'SKIPPED';

    const connector = await this.connectorFor(tenantId);
    if (!connector?.createLead) {
      if (existing && existing.status !== 'PENDING') return 'SKIPPED';
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
    const mode = connector.writeIdempotency ?? 'none';
    const claim = await this.operations.claim(
      ref,
      mode,
      now,
      LEAD_SYNC_LEASE_MS,
    );
    if (!claim.claimed) {
      // Another worker is attempting it, it is not due, or it has an outcome.
      return 'SKIPPED';
    }
    const op = claim.operation;
    await this.prisma.lead.updateMany({
      where: { id: lead.id, tenantId, crmSyncStatus: { not: 'SYNCED' } },
      data: { crmSyncStatus: 'PENDING', nextAttemptAt: null },
    });

    const step = beforeAttempt(op.previous, mode);
    if (step === 'STOP_UNCERTAIN') {
      await this.record(lead.id, op, now, {
        status: 'UNCERTAIN',
        execution: 'UNCERTAIN',
        errorCode: op.previous.abandoned
          ? 'ATTEMPT_ABANDONED'
          : 'OUTCOME_UNKNOWN',
      });
      return 'UNCERTAIN';
    }
    let phase: 'lookup' | 'create' = 'create';
    let created: string | undefined;
    try {
      if (step === 'LOOKUP_THEN_ATTEMPT') {
        phase = 'lookup';
        const found = await connector.findLeadByIdempotencyKey!(
          op.idempotencyKey,
        );
        if (found) {
          created = found.crmLeadId;
          this.logger.log(
            JSON.stringify({
              event: 'lead.crm_sync_recovered',
              tenant: tenantId,
              lead: lead.id,
            }),
          );
        }
        phase = 'create';
      }
      if (created === undefined) {
        const { crmLeadId } = await connector.createLead(
          {
            contact: {
              ...(lead.contact.name ? { name: lead.contact.name } : {}),
              ...(lead.contact.phone ? { phone: lead.contact.phone } : {}),
            },
            summary: lead.summary,
            slots: (lead.requirements ?? {}) as Record<string, unknown>,
            score: lead.score,
            reasonCodes: lead.reasonCodes,
          },
          { idempotencyKey: op.idempotencyKey },
        );
        created = crmLeadId;
      }
    } catch (error) {
      const code = errorCodeOf(error);
      // A failed lookup sent nothing, but the earlier attempt is still
      // unclear: keep it UNCERTAIN so the next attempt looks up again.
      const execution =
        phase === 'lookup' ? 'UNCERTAIN' : writeExecutionOf(error);
      const decision = afterFailure(
        execution,
        mode,
        op.attempt,
        MAX_LEAD_SYNC_ATTEMPTS,
        leadRetryDelayMs,
      );
      await this.record(
        lead.id,
        op,
        now,
        decision.status === 'RETRY_WAIT'
          ? {
              status: 'RETRY_WAIT',
              nextAttemptAt: new Date(now.getTime() + decision.delayMs),
              execution,
              errorCode: code,
            }
          : { status: decision.status, execution, errorCode: code },
      );
      this.logger.warn(
        JSON.stringify({
          event:
            decision.status === 'UNCERTAIN'
              ? 'lead.crm_sync_uncertain'
              : 'lead.crm_sync_failed',
          tenant: tenantId,
          lead: lead.id,
          code,
          execution,
          attempts: op.attempt,
        }),
      );
      return decision.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED';
    }
    // The CRM returned evidence. Recording it is retried briefly; if the
    // database stays unavailable the operation remains IN_FLIGHT and, after
    // the lease, is recovered by mode (native: same key returns the same
    // record; lookup: found; none: UNCERTAIN). Never treated as a CRM failure.
    await this.recordSuccess(lead.id, op, now, created as string);
    return 'SYNCED';
  }

  private async recordSuccess(
    leadId: string,
    op: ClaimedOperation,
    now: Date,
    externalId: string,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.record(leadId, op, now, { status: 'SUCCEEDED', externalId });
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((done) => setTimeout(done, 50 * attempt));
      }
    }
  }

  /** Operation outcome and the lead's summary fields, in one transaction. */
  private async record(
    leadId: string,
    op: ClaimedOperation,
    now: Date,
    outcome: Parameters<ConnectorOperations['finish']>[2],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const owned = await this.operations.finish(tx, op, outcome, now);
      if (!owned) return;
      const lead =
        outcome.status === 'SUCCEEDED'
          ? {
              crmSyncStatus: 'SYNCED' as const,
              crmLeadId: outcome.externalId,
              lastErrorCode: null,
              nextAttemptAt: null,
            }
          : {
              crmSyncStatus: 'FAILED' as const,
              lastErrorCode:
                outcome.status === 'UNCERTAIN'
                  ? CRM_OUTCOME_UNCERTAIN
                  : outcome.errorCode,
              nextAttemptAt:
                outcome.status === 'RETRY_WAIT' ? outcome.nextAttemptAt : null,
            };
      await tx.lead.updateMany({
        where: { id: leadId, tenantId: op.tenantId },
        data: { ...lead, attempts: op.attempt },
      });
    });
  }

  /**
   * Re-queues leads whose retry time has come (bounded attempts) and writes
   * whose attempt was abandoned (lease expired: crash or lost result). The
   * sync itself then decides, by idempotency mode, whether it may try again.
   */
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
      queued += await this.queue(
        lead.tenantId,
        lead.id,
        `retry:${lead.attempts}`,
      );
    }
    for (const op of await this.operations.abandoned(
      'createLead',
      'lead',
      now,
      limit,
    )) {
      queued += await this.queue(
        op.tenantId,
        op.subjectId,
        `recover:${op.id}:${op.attempts}`,
      );
    }
    return queued;
  }

  private async queue(
    tenantId: string,
    leadId: string,
    suffix: string,
  ): Promise<number> {
    const created = await this.prisma.outboxEvent.createMany({
      data: [
        {
          tenantId,
          type: 'crm.lead.sync',
          aggregateType: 'lead',
          aggregateId: leadId,
          idempotencyKey: `crm.lead.sync:${leadId}:${suffix}`,
          payload: { leadId } satisfies Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
    return created.count;
  }

  /**
   * A person checked the CRM for an UNCERTAIN write and records what they
   * found. Tenant-scoped, audited; only UNCERTAIN operations can be resolved.
   */
  async resolveUncertain(input: {
    tenantId: string;
    leadId: string;
    outcome: 'SUCCEEDED' | 'FAILED';
    crmLeadId?: string;
    actor: string;
    now?: Date;
  }): Promise<'RESOLVED' | 'NOT_UNCERTAIN' | 'MISSING_EVIDENCE'> {
    const now = input.now ?? new Date();
    if (input.outcome === 'SUCCEEDED' && !input.crmLeadId?.trim())
      return 'MISSING_EVIDENCE';
    const ref = this.ref(input.tenantId, input.leadId);
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.connectorOperation.updateMany({
        where: {
          tenantId: input.tenantId,
          kind: ref.kind,
          subjectType: ref.subjectType,
          subjectId: ref.subjectId,
          status: 'UNCERTAIN',
        },
        data:
          input.outcome === 'SUCCEEDED'
            ? {
                status: 'RESOLVED_SUCCEEDED',
                externalId: input.crmLeadId!.trim().slice(0, 200),
                resolvedBy: input.actor.slice(0, 200),
                completedAt: now,
              }
            : {
                status: 'RESOLVED_FAILED',
                resolvedBy: input.actor.slice(0, 200),
                completedAt: now,
              },
      });
      if (changed.count !== 1) return 'NOT_UNCERTAIN';
      await tx.lead.updateMany({
        where: { id: input.leadId, tenantId: input.tenantId },
        data:
          input.outcome === 'SUCCEEDED'
            ? {
                crmSyncStatus: 'SYNCED',
                crmLeadId: input.crmLeadId!.trim().slice(0, 200),
                lastErrorCode: null,
                nextAttemptAt: null,
              }
            : {
                crmSyncStatus: 'FAILED',
                lastErrorCode: 'RESOLVED_NOT_CREATED',
                nextAttemptAt: null,
              },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: 'ADMIN',
          actorId: input.actor.slice(0, 200),
          action: 'crm.operation.resolved',
          entityType: 'lead',
          entityId: input.leadId,
          safeInputSummary: { outcome: input.outcome },
        },
      });
      return 'RESOLVED';
    });
  }
}
