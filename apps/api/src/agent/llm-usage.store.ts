import { Injectable } from '@nestjs/common';
import type { LlmUsageEntry, LlmUsageSink } from '../core/llm/metered-llm.js';
import { PrismaService } from '../persistence/prisma.service.js';

/**
 * Tenant-scoped LLM usage ledger. Recording is idempotent on the provider
 * response id, so a retried persistence step cannot double count one
 * response. Spend totals are summed from this ledger before each turn.
 */
@Injectable()
export class LlmUsageStore implements LlmUsageSink {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: LlmUsageEntry): Promise<void> {
    await this.prisma.llmUsageRecord.createMany({
      data: [
        {
          tenantId: entry.tenantId,
          conversationId: entry.conversationId ?? null,
          turnKey: entry.turnKey.slice(0, 200),
          callIndex: entry.callIndex,
          purpose: entry.purpose,
          tier: entry.tier,
          provider: entry.providerId,
          model: entry.model,
          responseId: entry.responseId.slice(0, 200),
          inputTokens: entry.usage.inputTokens,
          outputTokens: entry.usage.outputTokens,
          cacheReadTokens: entry.usage.cacheReadTokens,
          cacheWrite5mTokens: entry.usage.cacheWrite5mTokens,
          cacheWrite1hTokens: entry.usage.cacheWrite1hTokens,
          reasoningTokens: entry.usage.reasoningTokens ?? null,
          costNano: BigInt(entry.costNano),
          reservedNano: BigInt(entry.reservedNano),
          pricingVersion: entry.pricingVersion,
          durationMs: entry.durationMs,
          attempts: entry.attempts,
          outcome: entry.outcome.slice(0, 40),
        },
      ],
      skipDuplicates: true,
    });
  }

  async conversationSpendNano(
    tenantId: string,
    conversationId: string,
  ): Promise<number> {
    const result = await this.prisma.llmUsageRecord.aggregate({
      where: { tenantId, conversationId },
      _sum: { costNano: true },
    });
    return Number(result._sum.costNano ?? 0n);
  }

  /** Spend since the start of the current UTC month. */
  async tenantMonthSpendNano(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const result = await this.prisma.llmUsageRecord.aggregate({
      where: { tenantId, createdAt: { gte: monthStart } },
      _sum: { costNano: true },
    });
    return Number(result._sum.costNano ?? 0n);
  }
}
