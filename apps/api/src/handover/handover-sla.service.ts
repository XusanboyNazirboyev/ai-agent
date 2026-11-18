import { Injectable, Optional } from '@nestjs/common';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';

/**
 * SLA scan: handovers still OPEN past their due time are marked once
 * (compare-and-set on `slaAlertedAt`) and a `handover.sla` event is queued,
 * which alerts the operator group and, if operators were reached, sends the
 * customer one delay notice. The due time is set at creation from
 * HANDOVER_SLA_MINUTES.
 */
@Injectable()
export class HandoverSlaService {
  /** RLS plan S7: finds overdue handovers of every tenant. */
  private readonly crossTenant: PrismaClient;

  constructor(
    private readonly prisma: PrismaService,
    // Optional only so specs can build it by hand; Nest always provides it.
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.crossTenant = privileged?.db ?? prisma;
  }

  async scan(now: Date = new Date(), limit = 50): Promise<number> {
    const due = await this.crossTenant.handover.findMany({
      where: { status: 'OPEN', slaDueAt: { lte: now }, slaAlertedAt: null },
      orderBy: { slaDueAt: 'asc' },
      take: limit,
      select: { id: true, tenantId: true },
    });
    let alerted = 0;
    for (const handover of due) {
      const done = await runWithTenant(handover.tenantId, () =>
        this.prisma.$transaction(async (tx) => {
          const claimed = await tx.handover.updateMany({
            where: {
              id: handover.id,
              tenantId: handover.tenantId,
              status: 'OPEN',
              slaAlertedAt: null,
            },
            data: { slaAlertedAt: now },
          });
          if (claimed.count !== 1) return false;
          await tx.outboxEvent.create({
            data: {
              tenantId: handover.tenantId,
              type: 'handover.sla',
              aggregateType: 'handover',
              aggregateId: handover.id,
              idempotencyKey: `handover.sla:${handover.id}`,
              payload: {
                handoverId: handover.id,
              } satisfies Prisma.InputJsonObject,
            },
          });
          return true;
        }),
      );
      if (done) alerted += 1;
    }
    return alerted;
  }
}
