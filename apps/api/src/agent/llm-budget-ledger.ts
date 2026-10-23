import { Injectable } from '@nestjs/common';
import type {
  BudgetLedger,
  LedgerReserveRequest,
  LedgerReserveResult,
} from '../core/llm/budget-ledger.js';
import type { LlmUsageEntry } from '../core/llm/metered-llm.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { usageRow } from './llm-usage.store.js';

/** States whose worst case still counts against the budget. */
const COUNTED = ['RESERVED', 'UNKNOWN'] as const;
const DEFAULT_TTL_MS = 10 * 60_000;

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * PostgreSQL budget ledger (ADR 014). Reservation is a short transaction
 * serialized per tenant by an advisory lock, so concurrent workers and
 * conversations cannot each spend the same remaining monthly budget. No
 * transaction stays open while a provider call is in flight.
 *
 * Accounting rules:
 * - spent = SUM(cost) in llm_usage_records (provider-reported only);
 * - exposure = reserved worst case of RESERVED and UNKNOWN rows;
 * - a RESERVED row older than its expiry (a crashed worker) becomes UNKNOWN,
 *   never free: its billing cannot be determined;
 * - a retry of the same call (same base id) turns any unfinished earlier row
 *   into UNKNOWN and gets its own row: it is a new provider invocation;
 * - a row leaves the count only by settlement (usage recorded in the same
 *   transaction) or by release of an attempt that certainly was not billed.
 */
@Injectable()
export class LlmBudgetLedger implements BudgetLedger {
  private ttlMs = DEFAULT_TTL_MS;
  private clock: () => Date = () => new Date();

  constructor(private readonly prisma: PrismaService) {}

  /** Test hook: a short reservation lifetime and a controllable clock. */
  configure(options: { ttlMs?: number; clock?: () => Date }): this {
    this.ttlMs = options.ttlMs ?? this.ttlMs;
    this.clock = options.clock ?? this.clock;
    return this;
  }

  async reserve(request: LedgerReserveRequest): Promise<LedgerReserveResult> {
    const now = this.clock();
    const periodStart = monthStart(now);
    const { tenantId, baseInvocationId } = request;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`llm-budget:${tenantId}`}, 0))) AS locked`;
      // Crash recovery and retry: unfinished earlier attempts keep counting.
      await tx.llmBudgetReservation.updateMany({
        where: {
          tenantId,
          state: 'RESERVED',
          OR: [{ expiresAt: { lt: now } }, { baseInvocationId }],
        },
        data: { state: 'UNKNOWN', updatedAt: now },
      });
      if (request.monthlyCapNano !== undefined) {
        const [spent, outstanding] = await Promise.all([
          tx.llmUsageRecord.aggregate({
            where: { tenantId, createdAt: { gte: periodStart } },
            _sum: { costNano: true },
          }),
          tx.llmBudgetReservation.aggregate({
            where: { tenantId, periodStart, state: { in: [...COUNTED] } },
            _sum: { reservedNano: true },
          }),
        ]);
        const committed =
          (spent._sum.costNano ?? 0n) +
          (outstanding._sum.reservedNano ?? 0n) +
          BigInt(request.worstCaseNano);
        if (committed > BigInt(request.monthlyCapNano))
          return { granted: false, reason: 'TENANT_MONTHLY_LIMIT' } as const;
      }
      const attempt = await tx.llmBudgetReservation.count({
        where: { tenantId, baseInvocationId },
      });
      const row = await tx.llmBudgetReservation.create({
        data: {
          tenantId,
          conversationId: request.conversationId ?? null,
          baseInvocationId,
          invocationId: `${baseInvocationId}#${attempt + 1}`,
          periodStart,
          reservedNano: BigInt(request.worstCaseNano),
          reservedTokens: BigInt(request.worstCaseTokens),
          state: 'RESERVED',
          expiresAt: new Date(now.getTime() + this.ttlMs),
        },
        select: { id: true },
      });
      return { granted: true, reservationId: row.id } as const;
    });
  }

  async settle(
    tenantId: string,
    reservationId: string,
    entry: LlmUsageEntry,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.llmUsageRecord.createMany({
        data: [usageRow(entry)],
        skipDuplicates: true,
      });
      // UNKNOWN -> SETTLED is allowed: a late completion with reported
      // usage justifies replacing the worst case by the actual cost.
      await tx.llmBudgetReservation.updateMany({
        where: { tenantId, id: reservationId, state: { in: [...COUNTED] } },
        data: { state: 'SETTLED', updatedAt: this.clock() },
      });
    });
  }

  async markUnknown(
    tenantId: string,
    reservationId: string,
    entry: LlmUsageEntry,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.llmBudgetReservation.updateMany({
        where: { tenantId, id: reservationId, state: 'RESERVED' },
        data: { state: 'UNKNOWN', updatedAt: this.clock() },
      });
      await tx.llmUsageRecord.createMany({
        data: [usageRow(entry)],
        skipDuplicates: true,
      });
    });
  }

  async release(tenantId: string, reservationId: string): Promise<void> {
    await this.prisma.llmBudgetReservation.updateMany({
      where: { tenantId, id: reservationId, state: 'RESERVED' },
      data: { state: 'RELEASED', updatedAt: this.clock() },
    });
  }

  /** Reserved and unknown exposure of one conversation (cost and tokens). */
  async conversationExposure(
    tenantId: string,
    conversationId: string,
  ): Promise<{ nano: number; tokens: number }> {
    const sum = await this.prisma.llmBudgetReservation.aggregate({
      where: { tenantId, conversationId, state: { in: [...COUNTED] } },
      _sum: { reservedNano: true, reservedTokens: true },
    });
    return {
      nano: Number(sum._sum.reservedNano ?? 0n),
      tokens: Number(sum._sum.reservedTokens ?? 0n),
    };
  }

  /** Reserved and unknown exposure of a tenant in the current UTC month. */
  async tenantMonthExposureNano(
    tenantId: string,
    now: Date = this.clock(),
  ): Promise<number> {
    const sum = await this.prisma.llmBudgetReservation.aggregate({
      where: {
        tenantId,
        periodStart: monthStart(now),
        state: { in: [...COUNTED] },
      },
      _sum: { reservedNano: true },
    });
    return Number(sum._sum.reservedNano ?? 0n);
  }
}
