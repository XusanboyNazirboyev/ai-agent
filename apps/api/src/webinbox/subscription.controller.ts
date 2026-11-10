import {
  Controller,
  ForbiddenException,
  Get,
  Optional,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantAccessService } from '../access/tenant-access.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { canManageTeam } from '../team/team-rules.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const OPEN = ['TRIAL', 'ACTIVE', 'PAST_DUE'] as const;

export interface TenantSubscriptionView {
  access: {
    state: string;
    periodEnd: Date | null;
    graceUntil: Date | null;
  };
  subscription: {
    status: string;
    planName: string;
    priceMinor: number;
    currency: string;
    periodDays: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    graceUntil: Date | null;
    canceledAt: Date | null;
  } | null;
  payments: {
    id: string;
    provider: string;
    amountMinor: number;
    currency: string;
    status: string;
    paidAt: Date | null;
    createdAt: Date;
  }[];
}

/**
 * The tenant's own subscription, read-only (ADR 047 §5, Settings →
 * Subscription), OWNER and ADMIN only. Tenant-scoped like every tenant
 * endpoint; writes happen only in the platform console.
 */
@Controller('api/v1/subscription')
@UseGuards(SessionGuard)
export class SubscriptionController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly access?: TenantAccessService,
  ) {}

  @Get()
  async view(@Req() request: InboxRequest): Promise<TenantSubscriptionView> {
    const principal = request.principal!;
    if (!canManageTeam(principal.role))
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const tenantId = principal.tenantId;
    const [rows, payments, access] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          plan: {
            select: {
              name: true,
              priceMinor: true,
              currency: true,
              periodDays: true,
            },
          },
        },
      }),
      this.prisma.subscriptionPayment.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.access ? this.access.check(tenantId) : undefined,
    ]);
    // The open row wins; otherwise the newest one.
    const row =
      rows.find((item) => (OPEN as readonly string[]).includes(item.status)) ??
      rows[0];
    return {
      access: {
        state: access?.state ?? 'ok',
        periodEnd: access?.periodEnd ?? null,
        graceUntil: access?.graceUntil ?? null,
      },
      subscription: row
        ? {
            status: row.status,
            planName: row.plan.name,
            priceMinor: Number(row.plan.priceMinor),
            currency: row.plan.currency,
            periodDays: row.plan.periodDays,
            currentPeriodStart: row.currentPeriodStart,
            currentPeriodEnd: row.currentPeriodEnd,
            graceUntil: row.graceUntil,
            canceledAt: row.canceledAt,
          }
        : null,
      payments: payments.map((payment) => ({
        id: payment.id,
        provider: payment.provider,
        amountMinor: Number(payment.amountMinor),
        currency: payment.currency,
        status: payment.status,
        paidAt: payment.paidAt,
        createdAt: payment.createdAt,
      })),
    };
  }
}
