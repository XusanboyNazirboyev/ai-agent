import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { parseBody } from './platform-http.js';
import { PlatformSessionGuard } from './platform-session.guard.js';
import {
  minorToDecimal,
  monthKeys,
  monthlyEquivalentMinor,
  OVERVIEW_TIME_ZONE,
} from './overview-math.js';
import { nanoToUsd } from './subscription-math.js';

const Query_ = z.strictObject({
  months: z.coerce.number().int().min(1).max(24).default(12),
});

const STATES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'EXPIRED',
  'CANCELED',
  'NONE',
] as const;
const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
const TRIAL_SOON_DAYS = 3;
const RECENT_ACTIONS = [
  'tenant.created',
  'subscription.started',
  'subscription.plan_changed',
  'subscription.extended',
  'subscription.canceled',
  'subscription.expired',
  'payment.recorded',
];

type Money = Record<string, string>;

export interface OverviewMonth {
  month: string;
  newCompanies: number;
  trialsStarted: number;
  convertedToPaid: number;
  churned: number;
  activeCompanies: number;
  revenue: Money;
}

export interface Overview {
  timeZone: string;
  generatedAt: string;
  companies: {
    total: number;
    byStatus: Record<(typeof TENANT_STATUSES)[number], number>;
    bySubscription: Record<(typeof STATES)[number], number>;
  };
  trialsEndingSoon: number;
  months: OverviewMonth[];
  revenue: { allTime: Money; thisMonth: Money; lastMonth: Money; mrr: Money };
  usageThisMonth: {
    conversations: number;
    inboundMessages: number;
    llmCostUsd: number;
  };
  recent: {
    id: string;
    kind: string;
    tenantId: string;
    tenantName: string;
    at: string;
  }[];
}

interface MonthCount {
  m: string;
  n: number;
}
interface MonthRevenue {
  m: string;
  currency: string;
  total: string;
}

/**
 * Business overview of the whole platform (ADR 047 amendment 2026-11-19).
 * Aggregates only (SQL group by); nothing loads every row. Cross-tenant on
 * the privileged connection like the other console reads.
 */
@Controller('api/v1/platform/overview')
@UseGuards(PlatformSessionGuard)
export class PlatformOverviewController {
  private readonly prisma: PrismaClient;

  constructor(privileged: PrivilegedDatabase) {
    this.prisma = privileged.db;
  }

  @Get()
  async overview(@Query() query: unknown): Promise<Overview> {
    const { months } = parseBody(Query_, query ?? {});
    return this.compute(months, new Date());
  }

  async compute(months: number, now: Date): Promise<Overview> {
    const tz = OVERVIEW_TIME_ZONE;
    // At least two months are read so "last month" exists for months = 1.
    const span = monthKeys(now, Math.max(months, 2), tz);
    const keys = span.slice(-months);
    const first = span[0]!;
    const current = span[span.length - 1]!;
    const previous = span[span.length - 2]!;
    const startOf = (key: string): Prisma.Sql =>
      Prisma.sql`((${key}::text || '-01')::timestamp AT TIME ZONE ${tz}::text)`;
    const since = startOf(first);
    const bucket = (column: string): Prisma.Sql =>
      Prisma.sql`to_char(${Prisma.raw(column)} AT TIME ZONE ${tz}::text, 'YYYY-MM')`;
    const noOpenRow = Prisma.sql`NOT EXISTS (SELECT 1 FROM tenant_subscriptions o WHERE o.tenant_id = e.tenant_id AND o.status IN ('TRIAL','ACTIVE','PAST_DUE'))`;
    const db = this.prisma;

    const [
      statusRows,
      stateRows,
      soon,
      created,
      trials,
      converted,
      churned,
      active,
      revenueRows,
      allTimeRows,
      mrrRows,
      usage,
      recentRows,
    ] = await Promise.all([
      db.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      db.$queryRaw<{ state: string; n: number }[]>`
        SELECT COALESCE(s.status::text, 'NONE') AS state, count(*)::int AS n
        FROM tenants t
        LEFT JOIN LATERAL (
          SELECT status FROM tenant_subscriptions
          WHERE tenant_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1
        ) s ON true
        GROUP BY 1`,
      db.tenantSubscription.count({
        where: {
          status: 'TRIAL',
          currentPeriodEnd: {
            gte: now,
            lte: new Date(now.getTime() + TRIAL_SOON_DAYS * 86_400_000),
          },
        },
      }),
      db.$queryRaw<MonthCount[]>`
        SELECT ${bucket('created_at')} AS m, count(*)::int AS n
        FROM tenants WHERE created_at >= ${since} GROUP BY 1`,
      db.$queryRaw<MonthCount[]>`
        SELECT ${bucket('e.created_at')} AS m, count(DISTINCT e.tenant_id)::int AS n
        FROM platform_audit_events e
        WHERE e.action = 'subscription.started'
          AND e.safe_summary->>'status' = 'TRIAL'
          AND e.tenant_id IS NOT NULL AND e.created_at >= ${since}
        GROUP BY 1`,
      db.$queryRaw<MonthCount[]>`
        WITH first_paid AS (
          SELECT tenant_id, min(paid_at) AS p FROM subscription_payments
          WHERE status = 'PAID' AND paid_at IS NOT NULL GROUP BY tenant_id)
        SELECT ${bucket('f.p')} AS m, count(*)::int AS n
        FROM first_paid f
        WHERE f.p >= ${since} AND EXISTS (
          SELECT 1 FROM platform_audit_events e
          WHERE e.tenant_id = f.tenant_id AND e.action = 'subscription.started'
            AND e.safe_summary->>'status' = 'TRIAL' AND e.created_at <= f.p)
        GROUP BY 1`,
      db.$queryRaw<MonthCount[]>`
        SELECT ${bucket('e.created_at')} AS m, count(DISTINCT e.tenant_id)::int AS n
        FROM platform_audit_events e
        WHERE e.action IN ('subscription.canceled', 'subscription.expired')
          AND e.tenant_id IS NOT NULL AND e.created_at >= ${since}
          AND ${noOpenRow}
        GROUP BY 1`,
      db.$queryRaw<MonthCount[]>`
        SELECT ${bucket('created_at')} AS m, count(DISTINCT tenant_id)::int AS n
        FROM messages WHERE direction = 'INBOUND' AND created_at >= ${since}
        GROUP BY 1`,
      db.$queryRaw<MonthRevenue[]>`
        SELECT ${bucket('paid_at')} AS m, currency, sum(amount_minor)::text AS total
        FROM subscription_payments
        WHERE status = 'PAID' AND paid_at >= ${since} GROUP BY 1, 2`,
      db.$queryRaw<{ currency: string; total: string }[]>`
        SELECT currency, sum(amount_minor)::text AS total
        FROM subscription_payments WHERE status = 'PAID' AND paid_at IS NOT NULL
        GROUP BY 1`,
      db.$queryRaw<
        { currency: string; price: string; period_days: number; n: number }[]
      >`
        SELECT p.currency, p.price_minor::text AS price, p.period_days, count(*)::int AS n
        FROM tenant_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
        WHERE s.status IN ('ACTIVE', 'PAST_DUE')
        GROUP BY 1, 2, 3`,
      this.usageSince(startOf(current)),
      db.platformAuditEvent.findMany({
        where: { action: { in: RECENT_ACTIONS }, tenantId: { not: null } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          id: true,
          action: true,
          createdAt: true,
          tenantId: true,
          tenant: { select: { name: true } },
        },
      }),
    ]);

    const counts = (rows: MonthCount[]): Map<string, number> =>
      new Map(rows.map((row) => [row.m, row.n]));
    const [cCreated, cTrials, cConverted, cChurned, cActive] = [
      created,
      trials,
      converted,
      churned,
      active,
    ].map(counts) as [Map<string, number>, ...Map<string, number>[]];
    const cashIn = new Map<string, Money>();
    for (const row of revenueRows) {
      const money = cashIn.get(row.m) ?? {};
      money[row.currency] = minorToDecimal(BigInt(row.total), row.currency);
      cashIn.set(row.m, money);
    }

    const byStatus = Object.fromEntries(
      TENANT_STATUSES.map((s) => [s, 0]),
    ) as Overview['companies']['byStatus'];
    let total = 0;
    for (const row of statusRows) {
      byStatus[row.status] = row._count._all;
      total += row._count._all;
    }
    const bySubscription = Object.fromEntries(
      STATES.map((s) => [s, 0]),
    ) as Overview['companies']['bySubscription'];
    for (const row of stateRows)
      bySubscription[row.state as (typeof STATES)[number]] = row.n;

    const allTime: Money = {};
    for (const row of allTimeRows)
      allTime[row.currency] = minorToDecimal(BigInt(row.total), row.currency);
    const mrrMinor = new Map<string, bigint>();
    for (const row of mrrRows)
      mrrMinor.set(
        row.currency,
        (mrrMinor.get(row.currency) ?? 0n) +
          monthlyEquivalentMinor(BigInt(row.price), row.period_days) *
            BigInt(row.n),
      );
    const mrr: Money = {};
    for (const [currency, minor] of mrrMinor)
      mrr[currency] = minorToDecimal(minor, currency);

    return {
      timeZone: tz,
      generatedAt: now.toISOString(),
      companies: { total, byStatus, bySubscription },
      trialsEndingSoon: soon,
      months: keys.map((month) => ({
        month,
        newCompanies: cCreated.get(month) ?? 0,
        trialsStarted: cTrials.get(month) ?? 0,
        convertedToPaid: cConverted.get(month) ?? 0,
        churned: cChurned.get(month) ?? 0,
        activeCompanies: cActive.get(month) ?? 0,
        revenue: cashIn.get(month) ?? {},
      })),
      revenue: {
        allTime,
        thisMonth: cashIn.get(current) ?? {},
        lastMonth: cashIn.get(previous) ?? {},
        mrr,
      },
      usageThisMonth: usage,
      recent: recentRows.map((row) => ({
        id: row.id,
        kind: row.action,
        tenantId: row.tenantId!,
        tenantName: row.tenant?.name ?? '',
        at: row.createdAt.toISOString(),
      })),
    };
  }

  private async usageSince(
    start: Prisma.Sql,
  ): Promise<Overview['usageThisMonth']> {
    const [row] = await this.prisma.$queryRaw<
      { conversations: number; inbound: number; nano: string | null }[]
    >`
      SELECT
        (SELECT count(*)::int FROM conversations WHERE created_at >= ${start}) AS conversations,
        (SELECT count(*)::int FROM messages WHERE direction = 'INBOUND' AND created_at >= ${start}) AS inbound,
        (SELECT sum(cost_nano_usd)::text FROM llm_usage_records WHERE created_at >= ${start}) AS nano`;
    return {
      conversations: row?.conversations ?? 0,
      inboundMessages: row?.inbound ?? 0,
      llmCostUsd: nanoToUsd(row?.nano ? BigInt(row.nano) : null),
    };
  }
}
