import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { ensureDefaultPipeline } from '../../leads/lead-stage.util.js';
import { moveLeadToStage } from '../../leads/lead-stage-move.js';
import type { ScheduledScan } from '../../handover/handover-runtime.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../../persistence/privileged-database.js';
import { runWithTenant } from '../../persistence/tenant-context.js';
import { ConnectorError } from '../interfaces/errors.js';
import { TenantConnectorLoader } from '../sync/tenant-connector-loader.js';
import { Bitrix24Connector } from './bitrix24-connector.js';
import {
  advanceCursor,
  defaultTarget,
  LEASE_MS,
  lostReasonFor,
  MAX_ITEMS_PER_RUN,
  PAGE_SIZE,
  scanSince,
  SCAN_INTERVAL_MS,
  type PortalLeadChange,
  type PortalStage,
  type StageSemantics,
} from './stage-sync-rules.js';

export interface OurStageView {
  id: string;
  code: string | null;
  name: string | null;
  kind: 'OPEN' | 'WON' | 'LOST';
}

export interface StageMappingView {
  externalStageId: string;
  name: string;
  semantics: StageSemantics;
  /** Our stage, or null = ignore. */
  leadStageId: string | null;
  /** False: this is the default, not yet saved. */
  saved: boolean;
}

export interface StageSyncView {
  enabled: boolean;
  lastRunAt: string | null;
  /** Error code of the last run, null when it went well. */
  lastErrorCode: string | null;
  /** False: the portal could not be asked now; the saved mapping is shown. */
  portalReachable: boolean;
  ourStages: OurStageView[];
  stages: StageMappingView[];
}

export interface StageSyncSave {
  enabled: boolean;
  mappings: Array<{ externalStageId: string; leadStageId: string | null }>;
}

/** Why a view or save could not be done; the controller maps these to HTTP. */
export class StageSyncRefusal extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'INVALID_BODY'
      | 'CRM_UNREACHABLE'
      | 'CRM_REJECTED',
  ) {
    super(code);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof ConnectorError) return error.code.slice(0, 100);
  if (error instanceof StageSyncRefusal) return error.code;
  return 'UNEXPECTED';
}

/**
 * Lead stages follow the connected Bitrix24 (ADR 079, slice 1): the mapping
 * between the portal's stages and ours, and the scan that moves leads when a
 * manager moves them in the portal. Polling only; no webhooks yet.
 */
@Injectable()
export class CrmStageSyncService implements ScheduledScan {
  private readonly logger = new Logger(CrmStageSyncService.name);
  /** RLS plan S7: lists connectors of every tenant; the work runs per tenant. */
  private readonly crossTenant: PrismaClient;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly loader: TenantConnectorLoader,
    // Optional only so specs can build it by hand; Nest always provides it.
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.crossTenant = privileged?.db ?? prisma;
  }

  // ---- settings (HTTP, tenant context set by the request) ----

  async view(tenantId: string, connectorId: string): Promise<StageSyncView> {
    const connector = await this.connector(tenantId, connectorId);
    const [sync, saved, ours] = await Promise.all([
      this.prisma.crmStageSync.findFirst({
        where: { tenantId, tenantConnectorId: connectorId },
      }),
      this.prisma.crmStageMapping.findMany({
        where: { tenantId, tenantConnectorId: connectorId },
      }),
      this.ourStages(tenantId),
    ]);
    const savedById = new Map(saved.map((m) => [m.externalStageId, m]));
    let portal: PortalStage[] | null = null;
    try {
      portal = await connector.listLeadStages();
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'crm_stage_sync.stages_failed',
          code: errorCode(error),
        }),
      );
    }
    const stages: StageMappingView[] = (
      portal ??
      saved.map((m) => ({
        id: m.externalStageId,
        name: m.externalStageName,
        sort: 0,
        semantics: 'process' as StageSemantics,
      }))
    ).map((stage) => {
      const row = savedById.get(stage.id);
      return {
        externalStageId: stage.id,
        name: stage.name,
        semantics: stage.semantics,
        leadStageId: row
          ? row.leadStageId
          : defaultTarget(stage.semantics, ours),
        saved: row !== undefined,
      };
    });
    return {
      enabled: sync?.enabled ?? false,
      lastRunAt: sync?.lastRunAt?.toISOString() ?? null,
      lastErrorCode: sync?.lastErrorCode ?? null,
      portalReachable: portal !== null,
      ourStages: ours,
      stages,
    };
  }

  /** Saves on/off and the whole mapping; returns the new view. */
  async save(
    tenantId: string,
    connectorId: string,
    operatorId: string,
    input: StageSyncSave,
  ): Promise<StageSyncView> {
    const connector = await this.connector(tenantId, connectorId);
    const ours = await this.ourStages(tenantId);
    const ourIds = new Set(ours.map((s) => s.id));
    let portal: PortalStage[];
    try {
      portal = await connector.listLeadStages();
    } catch (error) {
      throw new StageSyncRefusal(
        error instanceof ConnectorError && error.retryable
          ? 'CRM_UNREACHABLE'
          : 'CRM_REJECTED',
      );
    }
    const names = new Map(portal.map((s) => [s.id, s.name]));
    const seen = new Set<string>();
    for (const m of input.mappings) {
      if (
        !names.has(m.externalStageId) ||
        seen.has(m.externalStageId) ||
        (m.leadStageId !== null && !ourIds.has(m.leadStageId))
      )
        throw new StageSyncRefusal('INVALID_BODY');
      seen.add(m.externalStageId);
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.crmStageSync.findFirst({
        where: { tenantId, tenantConnectorId: connectorId },
      });
      await tx.crmStageMapping.deleteMany({
        where: { tenantId, tenantConnectorId: connectorId },
      });
      if (input.mappings.length > 0)
        await tx.crmStageMapping.createMany({
          data: input.mappings.map((m) => ({
            tenantId,
            tenantConnectorId: connectorId,
            externalStageId: m.externalStageId,
            externalStageName: names.get(m.externalStageId) ?? '',
            leadStageId: m.leadStageId,
          })),
        });
      if (!before) {
        await tx.crmStageSync.create({
          data: {
            tenantId,
            tenantConnectorId: connectorId,
            enabled: input.enabled,
            // Switching on starts from now: no history is replayed.
            cursorAt: input.enabled ? now : null,
          },
        });
      } else {
        await tx.crmStageSync.updateMany({
          where: { tenantId, tenantConnectorId: connectorId },
          data: {
            enabled: input.enabled,
            ...(input.enabled && !before.enabled
              ? { cursorAt: now, lastErrorCode: null }
              : {}),
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: operatorId,
          action: 'connector.stage_sync_saved',
          entityType: 'tenant_connector',
          entityId: connectorId,
          safeInputSummary: {
            connectorKey: 'bitrix24',
            enabled: input.enabled,
            mappings: input.mappings.length,
          },
        },
      });
    });
    return this.view(tenantId, connectorId);
  }

  private async connector(
    tenantId: string,
    connectorId: string,
  ): Promise<Bitrix24Connector> {
    const row = await this.prisma.tenantConnector.findFirst({
      where: {
        id: connectorId,
        tenantId,
        connectorKey: 'bitrix24',
        status: 'ACTIVE',
      },
    });
    if (!row) throw new StageSyncRefusal('NOT_FOUND');
    const connector = await this.loader.create(row);
    if (!(connector instanceof Bitrix24Connector))
      throw new StageSyncRefusal('NOT_FOUND');
    return connector;
  }

  /** Stages of the default pipeline (the one new leads enter). */
  private async ourStages(tenantId: string): Promise<OurStageView[]> {
    const { pipelineId } = await this.prisma.$transaction((tx) =>
      ensureDefaultPipeline(tx, tenantId),
    );
    const stages = await this.prisma.leadStage.findMany({
      where: { tenantId, pipelineId, archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    });
    return stages;
  }

  // ---- the scan ----

  /**
   * Returns how many leads were moved. `onlyTenantId` limits the pass to one
   * tenant (specs, manual runs); the scheduler passes nothing.
   */
  async scanDue(now: Date, onlyTenantId?: string): Promise<number> {
    const due = await this.crossTenant.crmStageSync.findMany({
      where: {
        enabled: true,
        ...(onlyTenantId ? { tenantId: onlyTenantId } : {}),
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          {
            OR: [
              { lastRunAt: null },
              { lastRunAt: { lt: new Date(now.getTime() - SCAN_INTERVAL_MS) } },
            ],
          },
        ],
      },
      orderBy: { lastRunAt: { sort: 'asc', nulls: 'first' } },
      take: 100,
      select: { id: true, tenantId: true, tenantConnectorId: true },
    });
    let moved = 0;
    for (const sync of due) {
      try {
        moved += await runWithTenant(sync.tenantId, () =>
          this.runOne(sync.tenantId, sync.id, sync.tenantConnectorId, now),
        );
      } catch (error) {
        // One connector never stops the others.
        this.logger.warn(
          JSON.stringify({
            event: 'crm_stage_sync.run_failed',
            code: errorCode(error),
          }),
        );
      }
    }
    return moved;
  }

  private async runOne(
    tenantId: string,
    syncId: string,
    connectorId: string,
    now: Date,
  ): Promise<number> {
    // Claim: only one scan polls a connector at a time, and not more often
    // than the interval, even with several API processes.
    const claimed = await this.prisma.crmStageSync.updateMany({
      where: {
        id: syncId,
        tenantId,
        enabled: true,
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          {
            OR: [
              { lastRunAt: null },
              { lastRunAt: { lt: new Date(now.getTime() - SCAN_INTERVAL_MS) } },
            ],
          },
        ],
      },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count !== 1) return 0;
    let moved = 0;
    let cursor: Date | undefined;
    let error: string | null = null;
    try {
      const result = await this.poll(tenantId, syncId, connectorId, now);
      moved = result.moved;
      cursor = result.cursor;
      error = result.error;
    } catch (caught) {
      error = errorCode(caught);
      if (caught instanceof PollInterrupted) {
        moved = caught.moved;
        cursor = caught.cursor;
        error = errorCode(caught.reason);
      }
    }
    await this.prisma.crmStageSync.updateMany({
      where: { id: syncId, tenantId },
      data: {
        lastRunAt: now,
        lastErrorCode: error,
        leaseUntil: null,
        ...(cursor ? { cursorAt: cursor } : {}),
      },
    });
    if (moved > 0)
      this.logger.log(
        JSON.stringify({ event: 'crm_stage_sync.moved', count: moved }),
      );
    return moved;
  }

  private async poll(
    tenantId: string,
    syncId: string,
    connectorId: string,
    now: Date,
  ): Promise<{ moved: number; cursor: Date; error: string | null }> {
    const sync = await this.prisma.crmStageSync.findFirstOrThrow({
      where: { id: syncId, tenantId },
      select: { cursorAt: true },
    });
    // Never switched on properly: start from now, replay nothing.
    if (!sync.cursorAt) return { moved: 0, cursor: now, error: null };
    const connector = await this.connector(tenantId, connectorId);
    const mappings = await this.prisma.crmStageMapping.findMany({
      where: { tenantId, tenantConnectorId: connectorId },
      include: { leadStage: { select: { id: true, kind: true } } },
    });
    const byStage = new Map(mappings.map((m) => [m.externalStageId, m]));
    const since = scanSince(sync.cursorAt);
    let cursor = sync.cursorAt;
    let moved = 0;
    let seen = 0;
    let warning: string | null = null;
    try {
      for (let start = 0; seen < MAX_ITEMS_PER_RUN; start += PAGE_SIZE) {
        const page = await connector.listChangedLeads(since, start);
        for (const change of page) {
          const outcome = await this.apply(tenantId, byStage, change);
          moved += outcome.moved;
          warning = outcome.warning ?? warning;
          seen += 1;
          cursor = advanceCursor(cursor, [change]);
        }
        if (page.length < PAGE_SIZE) break;
      }
    } catch (caught) {
      // Keep what was processed: the cursor only moves past finished items.
      throw new PollInterrupted(caught, moved, cursor);
    }
    return { moved, cursor, error: warning };
  }

  /** One changed portal lead -> our lead(s). Never throws for a mapping problem. */
  private async apply(
    tenantId: string,
    byStage: ReadonlyMap<
      string,
      {
        externalStageName: string;
        leadStageId: string | null;
        leadStage: { id: string; kind: string } | null;
      }
    >,
    change: PortalLeadChange,
  ): Promise<{ moved: number; warning?: string }> {
    const mapping = byStage.get(change.stageId);
    if (!mapping?.leadStageId || !mapping.leadStage) return { moved: 0 };
    const operations = await this.prisma.connectorOperation.findMany({
      where: {
        tenantId,
        kind: 'createLead',
        subjectType: 'lead',
        status: { in: ['SUCCEEDED', 'RESOLVED_SUCCEEDED'] },
        externalId: String(change.id),
      },
      select: { subjectId: true },
    });
    if (operations.length === 0) return { moved: 0 };
    const leads = await this.prisma.lead.findMany({
      where: {
        tenantId,
        id: { in: operations.map((o) => o.subjectId) },
        archivedAt: null,
      },
      select: { id: true, pipelineStageId: true },
    });
    let moved = 0;
    let warning: string | undefined;
    for (const lead of leads) {
      if (lead.pipelineStageId === mapping.leadStageId) continue;
      try {
        const result = await this.prisma.$transaction((tx) =>
          moveLeadToStage(tx, {
            tenantId,
            leadId: lead.id,
            stageId: mapping.leadStageId!,
            actor: 'OPERATOR',
            lostReason:
              mapping.leadStage!.kind === 'LOST'
                ? lostReasonFor(mapping.externalStageName)
                : null,
            auditExtra: {
              source: 'bitrix24',
              externalStageId: change.stageId.slice(0, 100),
            },
          }),
        );
        if (result.moved) moved += 1;
      } catch (error) {
        // A mapped stage that is archived or gone: report, keep going.
        if (!(error instanceof HttpException)) throw error;
        warning = 'MAPPING_INVALID';
      }
    }
    return { moved, ...(warning ? { warning } : {}) };
  }
}

/** A run stopped by an error after some items were processed. */
class PollInterrupted extends Error {
  constructor(
    readonly reason: unknown,
    readonly moved: number,
    readonly cursor: Date,
  ) {
    super('poll interrupted');
  }
}
