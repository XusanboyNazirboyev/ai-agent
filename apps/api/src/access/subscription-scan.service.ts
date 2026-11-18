import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import {
  OPERATOR_ALERT_EVENT,
  type OperatorAlert,
} from '../observability/alerts.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantAccessService } from './tenant-access.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

export const PAST_DUE_EVENT = 'subscription.past_due';
export const EXPIRED_EVENT = 'subscription.expired';
/**
 * Days before the period end at which the tenant's Telegram operator group
 * is reminded (ADR 047 amendment "reminder"): the first matches the in-app
 * banner's window, the second is the last day.
 */
export const REMIND_DAYS_BEFORE = [5, 1] as const;

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
    return (
      (await this.markPastDue(now)) +
      (await this.markExpired(now)) +
      (await this.remindEnding(now))
    );
  }

  /**
   * One reminder per period and stage, through the operator group like the
   * budget alert (outbox, retried; the idempotency key makes repeated or
   * concurrent scans harmless). Only running TRIAL/ACTIVE periods of active
   * tenants with an operator group; a renewed period gets its own reminders.
   */
  private async remindEnding(now: Date): Promise<number> {
    const first = Math.max(...REMIND_DAYS_BEFORE);
    const due = await this.prisma.tenantSubscription.findMany({
      where: {
        status: { in: ['TRIAL', 'ACTIVE'] },
        currentPeriodEnd: {
          gt: now,
          lte: new Date(now.getTime() + first * DAY_MS),
        },
        tenant: {
          status: 'ACTIVE',
          channelAccounts: {
            some: { operatorChatId: { not: null }, status: 'ACTIVE' },
          },
        },
      },
      select: { id: true, tenantId: true, currentPeriodEnd: true },
      orderBy: { currentPeriodEnd: 'asc' },
      take: BATCH,
    });
    let queued = 0;
    for (const row of due) {
      const daysLeft = Math.ceil(
        (row.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS,
      );
      // The latest stage reached: 3 days left is the 5-day reminder.
      const stage = Math.min(
        ...REMIND_DAYS_BEFORE.filter((days) => daysLeft <= days),
      );
      const periodEnd = row.currentPeriodEnd.toISOString();
      const alert: OperatorAlert = {
        kind: 'SUBSCRIPTION_ENDING',
        periodEnd,
        daysLeft,
      };
      const created = await this.prisma.outboxEvent.createMany({
        data: [
          {
            tenantId: row.tenantId,
            type: OPERATOR_ALERT_EVENT,
            aggregateType: 'tenant',
            aggregateId: row.tenantId,
            idempotencyKey: `alert:subscription-ending:${row.id}:${periodEnd}:${stage}`,
            payload: alert satisfies Prisma.InputJsonObject,
          },
        ],
        skipDuplicates: true,
      });
      queued += created.count;
    }
    return queued;
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
