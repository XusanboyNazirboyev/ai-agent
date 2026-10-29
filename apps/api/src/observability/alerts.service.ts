import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { monthStart } from '../agent/llm-budget-ledger.js';
import type { AppEnvironment } from '../config/environment.js';
import { usdToNano } from '../core/llm/pricing.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { PrismaService } from '../persistence/prisma.service.js';

export const OPERATOR_ALERT_EVENT = 'alert.operator';

export type OperatorAlert =
  | {
      readonly kind: 'BUDGET_NEAR_LIMIT';
      readonly percent: number;
      readonly month: string;
    }
  | { readonly kind: 'CRM_SYNC_FAILURES'; readonly count: number };

const HOUR_MS = 3_600_000;

/**
 * In-process alerts (Phase 7.3, ADR 030). Off unless ALERTS_ENABLED=true.
 *
 * Per tenant, through the tenant's Telegram operator group (outbox event
 * `alert.operator`, so delivery retries like the digest):
 * - the month-to-date LLM spend reached ALERT_BUDGET_PERCENT of
 *   LLM_TENANT_MONTHLY_BUDGET_USD (once per tenant and UTC month);
 * - at least ALERT_CRM_FAILURES_PER_HOUR leads failed CRM sync in the last
 *   hour (once per tenant and UTC hour).
 * The outbox idempotency key makes repeated or concurrent scans harmless.
 *
 * Platform-wide, as `alert.*` log lines for the host to collect (they are
 * not one tenant's business): outbox events waiting longer than
 * ALERT_OUTBOX_BACKLOG_MINUTES, and at least ALERT_FAILED_TURNS_PER_HOUR
 * failed agent turns in the last hour. Each is logged at most once per
 * UTC hour by this process.
 */
@Injectable()
export class AlertsService implements ScheduledScan {
  private readonly logger = new Logger(AlertsService.name);
  private readonly logged = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async scanDue(now: Date): Promise<number> {
    if (this.config.get('ALERTS_ENABLED', { infer: true }) !== true) return 0;
    let queued = 0;
    const tenants = await this.prisma.channelAccount.findMany({
      where: {
        operatorChatId: { not: null },
        status: 'ACTIVE',
        tenant: { status: 'ACTIVE' },
      },
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    for (const { tenantId } of tenants) {
      queued += await this.budget(tenantId, now);
      queued += await this.crmFailures(tenantId, now);
    }
    await this.platform(now);
    return queued;
  }

  private async budget(tenantId: string, now: Date): Promise<number> {
    const capUsd = this.config.get('LLM_TENANT_MONTHLY_BUDGET_USD', {
      infer: true,
    });
    if (capUsd === undefined) return 0;
    const capNano = BigInt(usdToNano(capUsd));
    if (capNano <= 0n) return 0;
    const start = monthStart(now);
    const spent = await this.prisma.llmUsageRecord.aggregate({
      where: { tenantId, createdAt: { gte: start, lte: now } },
      _sum: { costNano: true },
    });
    const spentNano = spent._sum.costNano ?? 0n;
    const threshold = BigInt(
      this.config.get('ALERT_BUDGET_PERCENT', { infer: true }),
    );
    if (spentNano * 100n < capNano * threshold) return 0;
    const month = start.toISOString().slice(0, 7);
    const percent = Number((spentNano * 100n) / capNano);
    return this.queue(tenantId, `alert:budget:${tenantId}:${month}`, {
      kind: 'BUDGET_NEAR_LIMIT',
      percent,
      month,
    });
  }

  private async crmFailures(tenantId: string, now: Date): Promise<number> {
    const count = await this.prisma.lead.count({
      where: {
        tenantId,
        crmSyncStatus: 'FAILED',
        updatedAt: { gt: new Date(now.getTime() - HOUR_MS), lte: now },
      },
    });
    if (count < this.config.get('ALERT_CRM_FAILURES_PER_HOUR', { infer: true }))
      return 0;
    return this.queue(tenantId, `alert:crm:${tenantId}:${hourKey(now)}`, {
      kind: 'CRM_SYNC_FAILURES',
      count,
    });
  }

  private async queue(
    tenantId: string,
    idempotencyKey: string,
    alert: OperatorAlert,
  ): Promise<number> {
    const created = await this.prisma.outboxEvent.createMany({
      data: [
        {
          tenantId,
          type: OPERATOR_ALERT_EVENT,
          aggregateType: 'tenant',
          aggregateId: tenantId,
          idempotencyKey,
          payload: alert satisfies Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
    return created.count;
  }

  private async platform(now: Date): Promise<void> {
    const hour = hourKey(now);
    const backlogMinutes = this.config.get('ALERT_OUTBOX_BACKLOG_MINUTES', {
      infer: true,
    });
    const waiting = await this.prisma.outboxEvent.aggregate({
      where: {
        status: 'PENDING',
        availableAt: { lte: new Date(now.getTime() - backlogMinutes * 60_000) },
      },
      _count: { _all: true },
      _min: { availableAt: true },
    });
    if (waiting._count._all > 0)
      this.once(`backlog:${hour}`, 'warn', {
        event: 'alert.outbox_backlog',
        waiting: waiting._count._all,
        oldestMinutes: Math.floor(
          (now.getTime() - (waiting._min.availableAt ?? now).getTime()) /
            60_000,
        ),
      });

    const failed = await this.prisma.agentTurn.count({
      where: {
        status: 'FAILED',
        completedAt: { gt: new Date(now.getTime() - HOUR_MS), lte: now },
      },
    });
    if (
      failed >= this.config.get('ALERT_FAILED_TURNS_PER_HOUR', { infer: true })
    )
      this.once(`failed-turns:${hour}`, 'error', {
        event: 'alert.failed_turns',
        failedLastHour: failed,
      });
  }

  private once(
    key: string,
    level: 'warn' | 'error',
    record: Record<string, string | number>,
  ): void {
    if (this.logged.has(key)) return;
    if (this.logged.size > 1_000) this.logged.clear();
    this.logged.add(key);
    this.logger[level](JSON.stringify(record));
  }
}

/** UTC hour, e.g. 2026-10-28T10. */
function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}
