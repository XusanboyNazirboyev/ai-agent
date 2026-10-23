import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { Prisma } from '../generated/prisma/client.js';
import { localHour } from '../core/followup/policy.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { ScheduledScan } from './handover-runtime.js';

/** Local calendar date (YYYY-MM-DD) in an IANA time zone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Queues one operator digest per tenant per local day, once the tenant's
 * local time has reached DIGEST_HOUR. The outbox idempotency key
 * (tenant, date) makes concurrent or repeated scans harmless; the content is
 * built when the event is processed, so it is current at delivery time.
 */
@Injectable()
export class DigestService implements ScheduledScan {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async scanDue(now: Date): Promise<number> {
    const hour: number = this.config.get('DIGEST_HOUR', { infer: true }) ?? 9;
    const accounts = await this.prisma.channelAccount.findMany({
      where: {
        operatorChatId: { not: null },
        status: 'ACTIVE',
        tenant: { status: 'ACTIVE' },
      },
      distinct: ['tenantId'],
      select: { tenantId: true, tenant: { select: { timezone: true } } },
    });
    let queued = 0;
    for (const account of accounts) {
      const zone = account.tenant.timezone;
      if (localHour(now, zone) < hour) continue;
      const date = localDate(now, zone);
      const created = await this.prisma.outboxEvent.createMany({
        data: [
          {
            tenantId: account.tenantId,
            type: 'digest.morning',
            aggregateType: 'tenant',
            aggregateId: account.tenantId,
            idempotencyKey: `digest:${account.tenantId}:${date}`,
            payload: { date } satisfies Prisma.InputJsonObject,
          },
        ],
        skipDuplicates: true,
      });
      queued += created.count;
    }
    return queued;
  }
}
