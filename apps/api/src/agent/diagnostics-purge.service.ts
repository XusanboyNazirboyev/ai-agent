import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { PrismaService } from '../persistence/prisma.service.js';

/**
 * Bounded retention for blocked-draft diagnostics (ADR 029): expired records
 * are cleared, the rest of the turn record stays. Idempotent, so several API
 * processes may run it.
 */
@Injectable()
export class DiagnosticsPurgeService implements ScheduledScan {
  constructor(private readonly prisma: PrismaService) {}

  async scanDue(now: Date): Promise<number> {
    const { count } = await this.prisma.agentTurn.updateMany({
      where: { diagnosticsExpiresAt: { lte: now } },
      data: { diagnostics: Prisma.DbNull, diagnosticsExpiresAt: null },
    });
    return count;
  }
}
