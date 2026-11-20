import { Controller, Get, HttpException, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { planLimitsOf } from '../access/plan-limits.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import {
  loginClientAddress,
  type AddressedRequest,
} from '../webinbox/client-address.js';
import { LoginRateLimiter } from '../webinbox/auth.controller.js';

export interface PublicPlanView {
  code: string;
  name: string;
  /** A string: minor units can exceed 2^53 in other currencies. */
  priceMinor: string;
  currency: string;
  periodDays: number;
  /** Public keys only (ADR 080); everything else stays private. */
  limits: {
    monthlyNewLeads?: number;
    maxOperators?: number;
    maxChannelAccounts?: number;
  };
}

export interface PublicPlansResponse {
  plans: PublicPlanView[];
  contactUrl: string | null;
}

const TTL_MS = 60_000;

/**
 * ADR 080: the plans the public sales page shows. No session; per-address
 * rate limit like sign-in; the answer is cached in memory for 60 seconds.
 * `subscription_plans` is a platform table without tenant data, read on the
 * normal connection, so this lives outside `src/platform`.
 */
@Controller('api/v1/public')
export class PublicPlansController {
  private readonly limiter = new LoginRateLimiter(60);
  private cache: { at: number; body: PublicPlansResponse } | undefined;

  // Plans belong to no tenant and this runs before any session (RLS plan S5).
  private readonly prisma: PrismaClient;

  constructor(
    privileged: PrivilegedDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {
    this.prisma = privileged.db;
  }

  @Get('plans')
  async plans(@Req() request: AddressedRequest): Promise<PublicPlansResponse> {
    const allowed = this.limiter.allow(
      loginClientAddress(
        request,
        this.config.get('WEB_PROXY_SECRET', { infer: true }),
      ),
    );
    if (!allowed)
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          i18nKey: 'errors.rateLimited',
        },
        429,
      );
    const now = Date.now();
    if (this.cache && now - this.cache.at < TTL_MS) return this.cache.body;
    const rows = await this.prisma.subscriptionPlan.findMany({
      where: { isActive: true, isPublic: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: 20,
    });
    const body: PublicPlansResponse = {
      plans: rows.map((plan) => {
        const limits = planLimitsOf(plan.limits);
        return {
          code: plan.code,
          name: plan.name,
          priceMinor: plan.priceMinor.toString(),
          currency: plan.currency,
          periodDays: plan.periodDays,
          limits: {
            ...(limits.monthlyNewLeads !== undefined
              ? { monthlyNewLeads: limits.monthlyNewLeads }
              : {}),
            ...(limits.maxOperators !== undefined
              ? { maxOperators: limits.maxOperators }
              : {}),
            ...(limits.maxChannelAccounts !== undefined
              ? { maxChannelAccounts: limits.maxChannelAccounts }
              : {}),
          },
        };
      }),
      contactUrl:
        this.config.get('PUBLIC_SALES_CONTACT_URL', { infer: true }) ?? null,
    };
    this.cache = { at: now, body };
    return body;
  }
}
