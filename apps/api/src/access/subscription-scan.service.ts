import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantAccessService } from './tenant-access.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

export const PAST_DUE_EVENT = 'subscription.past_due';
export const EXPIRED_EVENT = 'subscription.expired';

/**
 * Subscription lifecycle (ADR 047 §3): open TRIAL/ACTIVE rows past their
 * period end become PAST_DUE with `grace_until = end + grace days`; PAST_DUE
 * rows past `grace_until` become EXPIRED. Each transition is a conditional
 * update (idempotent, safe across processes) followed by one platform audit
 * event and one inbox event.
 */
@Injectable()
export class SubscriptionScanService implements ScheduledScan {
  private readonly graceDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppEnvironment, true>,
    @Optional() private readonly access?: TenantAccessService,
  ) {
    const configured = Number(
      config.get('SUBSCRIPTION_GRACE_DAYS', { infer: true }),
    );
    this.graceDays =
      Number.isInteger(configured) && configured >= 0 ? configured : 3;
  }

  async scanDue(now: Date): Promise<number> {
    return (await this.markPastDue(now)) + (await this.markExpired(now));
  }

  private async markPastDue(now: Date): Promise<number> {
    const due = await this.prisma.tenantSubscription.findMany({
      where: {
        status: { in: ['TRIAL', 'ACTIVE'] },
        currentPeriodEnd: { lte: now },
      },
      select: {
        id: true,
        tenantId: true,
        status: true,
        currentPeriodEnd: true,
      },
      orderBy: { currentPeriodEnd: 'asc' },
      take: BATCH,
    });
    let changed = 0;
    for (const row of due) {
      const graceUntil = new Date(
        row.currentPeriodEnd.getTime() + this.graceDays * DAY_MS,
      );
      const moved = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.tenantSubscription.updateMany({
          where: { id: row.id, tenantId: row.tenantId, status: row.status },
          data: { status: 'PAST_DUE', graceUntil },
        });
        if (updated.count !== 1) return false;
        await tx.platformAuditEvent.create({
          data: {
            action: 'subscription.past_due',
            tenantId: row.tenantId,
            entityType: 'tenant_subscription',
            entityId: row.id,
            safeSummary: {
              from: row.status,
              periodEnd: row.currentPeriodEnd.toISOString(),
              graceUntil: graceUntil.toISOString(),
            },
          },
        });
        await tx.inboxEvent.create({
          data: { tenantId: row.tenantId, type: PAST_DUE_EVENT },
        });
        return true;
      });
      if (moved) {
        changed += 1;
        this.access?.invalidate(row.tenantId);
      }
    }
    return changed;
  }

  private async markExpired(now: Date): Promise<number> {
    const due = await this.prisma.tenantSubscription.findMany({
      where: { status: 'PAST_DUE', graceUntil: { lte: now } },
      select: { id: true, tenantId: true, graceUntil: true },
      orderBy: { graceUntil: 'asc' },
      take: BATCH,
    });
    let changed = 0;
    for (const row of due) {
      const moved = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.tenantSubscription.updateMany({
          where: { id: row.id, tenantId: row.tenantId, status: 'PAST_DUE' },
          data: { status: 'EXPIRED' },
        });
        if (updated.count !== 1) return false;
        await tx.platformAuditEvent.create({
          data: {
            action: 'subscription.expired',
            tenantId: row.tenantId,
            entityType: 'tenant_subscription',
            entityId: row.id,
            safeSummary: { graceUntil: row.graceUntil?.toISOString() ?? null },
          },
        });
        await tx.inboxEvent.create({
          data: { tenantId: row.tenantId, type: EXPIRED_EVENT },
        });
        return true;
      });
      if (moved) {
        changed += 1;
        this.access?.invalidate(row.tenantId);
      }
    }
    return changed;
  }
}
