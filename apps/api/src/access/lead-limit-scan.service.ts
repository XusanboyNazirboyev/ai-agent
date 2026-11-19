import { Injectable, Optional } from '@nestjs/common';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import {
  OPERATOR_ALERT_EVENT,
  type OperatorAlert,
} from '../observability/alerts.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import {
  countNewLeadsThisMonth,
  localMonth,
  reachedThreshold,
} from './lead-limit.js';
import { OPEN_SUBSCRIPTION_STATES, planLimitsOf } from './plan-limits.js';

const BATCH = 500;
/** The scan runs at most this often per process; the outbox key makes repeats harmless anyway. */
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * ADR 080 "Lead limit warnings". Counts each tenant's leads created this
 * calendar month (tenant time zone) against the open plan's `monthlyNewLeads`
 * and, at 80 % and 100 %, queues ONE operator-group message per tenant, month
 * and threshold. The marker is the outbox idempotency key
 * `alert:new-leads:<tenant>:<YYYY-MM>:<threshold>` (same channel as the
 * subscription reminder, no new table). When the count jumps past both
 * thresholds only the highest is sent. Nothing is blocked.
 */
@Injectable()
export class LeadLimitScanService implements ScheduledScan {
  /** RLS plan S7: finds due work of every tenant; the work runs per tenant. */
  private readonly crossTenant: PrismaClient;
  private lastRun = 0;

  constructor(
    private readonly prisma: PrismaService,
    // Optional only so specs can build it by hand; Nest always provides it.
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.crossTenant = privileged?.db ?? prisma;
  }

  async scanDue(now: Date): Promise<number> {
    if (this.lastRun && now.getTime() - this.lastRun < MIN_INTERVAL_MS)
      return 0;
    this.lastRun = now.getTime();
    const rows = await this.crossTenant.tenantSubscription.findMany({
      where: {
        status: { in: [...OPEN_SUBSCRIPTION_STATES] },
        plan: { limits: { path: ['monthlyNewLeads'], gt: 0 } },
        tenant: {
          status: 'ACTIVE',
          channelAccounts: {
            some: { operatorChatId: { not: null }, status: 'ACTIVE' },
          },
        },
      },
      select: {
        tenantId: true,
        plan: { select: { limits: true } },
        tenant: { select: { timezone: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    let queued = 0;
    for (const row of rows) {
      const limit = planLimitsOf(row.plan.limits).monthlyNewLeads;
      if (limit === undefined) continue;
      const zone = row.tenant.timezone;
      const month = localMonth(now, zone);
      const count = await runWithTenant(row.tenantId, () =>
        countNewLeadsThisMonth(this.prisma, row.tenantId, zone, now),
      );
      const threshold = reachedThreshold(count, limit);
      if (threshold === 0) continue;
      const alert: OperatorAlert = {
        kind: 'LEAD_LIMIT',
        percent: threshold,
        count,
        limit,
        month,
      };
      const created = await runWithTenant(row.tenantId, () =>
        this.prisma.outboxEvent.createMany({
          data: [
            {
              tenantId: row.tenantId,
              type: OPERATOR_ALERT_EVENT,
              aggregateType: 'tenant',
              aggregateId: row.tenantId,
              idempotencyKey: `alert:new-leads:${row.tenantId}:${month}:${threshold}`,
              payload: alert satisfies Prisma.InputJsonObject,
            },
          ],
          skipDuplicates: true,
        }),
      );
      queued += created.count;
    }
    return queued;
  }
}
