import { Injectable } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  billingRequired,
  decideAccess,
  type TenantAccess,
} from './access-decision.js';

export const ACCESS_CACHE_MS = 60_000;

/**
 * Whether a tenant is suspended, archived or out of subscription (ADR 047
 * §3). Answers are cached for 60 s per tenant and process; writers in the
 * same process call `invalidate`. An unknown tenant is reported ARCHIVED.
 */
@Injectable()
export class TenantAccessService {
  private readonly cache = new Map<
    string,
    { readonly value: TenantAccess; readonly at: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  async check(tenantId: string, now = new Date()): Promise<TenantAccess> {
    const cached = this.cache.get(tenantId);
    if (cached && now.getTime() - cached.at < ACCESS_CACHE_MS)
      return cached.value;
    const value = await this.load(tenantId, now);
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(tenantId, { value, at: now.getTime() });
    return value;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async load(tenantId: string, now: Date): Promise<TenantAccess> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, config: true },
    });
    if (!tenant)
      return {
        state: 'ARCHIVED',
        subscriptionStatus: null,
        periodEnd: null,
        graceUntil: null,
      };
    // The open row wins (there is at most one); otherwise the newest.
    const open = await this.prisma.tenantSubscription.findFirst({
      where: { tenantId, status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } },
      select: { status: true, currentPeriodEnd: true, graceUntil: true },
    });
    const latest =
      open ??
      (await this.prisma.tenantSubscription.findFirst({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        select: { status: true, currentPeriodEnd: true, graceUntil: true },
      }));
    return decideAccess(
      {
        tenantStatus: tenant.status,
        billingRequired: billingRequired(tenant.config),
        latest,
      },
      now,
    );
  }
}
