import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { localHour } from '../core/followup/policy.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
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
  /** RLS plan S7: finds due work of every tenant; the work runs per tenant. */
  private readonly crossTenant: PrismaClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    // Optional only so specs can build it by hand; Nest always provides it.
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.crossTenant = privileged?.db ?? prisma;
  }

  async scanDue(now: Date): Promise<number> {
    if (this.config.get('DIGEST_ENABLED', { infer: true }) !== true) return 0;
    const hour: number = this.config.get('DIGEST_HOUR', { infer: true }) ?? 9;
    const accounts = await this.crossTenant.channelAccount.findMany({
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
      const created = await runWithTenant(account.tenantId, () =>
        this.prisma.outboxEvent.createMany({
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
        }),
      );
      queued += created.count;
    }
    return queued;
  }
}
