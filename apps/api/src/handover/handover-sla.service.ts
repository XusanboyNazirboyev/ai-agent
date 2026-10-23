import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';

/**
 * SLA scan: handovers still OPEN past their due time are marked once
 * (compare-and-set on `slaAlertedAt`) and a `handover.sla` event is queued,
 * which alerts the operator group and, if operators were reached, sends the
 * customer one delay notice. The due time is set at creation from
 * HANDOVER_SLA_MINUTES.
 */
@Injectable()
export class HandoverSlaService {
  constructor(private readonly prisma: PrismaService) {}

  async scan(now: Date = new Date(), limit = 50): Promise<number> {
    const due = await this.prisma.handover.findMany({
      where: { status: 'OPEN', slaDueAt: { lte: now }, slaAlertedAt: null },
      orderBy: { slaDueAt: 'asc' },
      take: limit,
      select: { id: true, tenantId: true },
    });
    let alerted = 0;
    for (const handover of due) {
      const done = await this.prisma.$transaction(async (tx) => {
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
      });
      if (done) alerted += 1;
    }
    return alerted;
  }
}
