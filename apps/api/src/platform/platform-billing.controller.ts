import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TenantAccessService } from '../access/tenant-access.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { recordPlatformAudit } from './platform-audit.js';
import {
  conflict,
  isUniqueViolation,
  notFound,
  parseBody,
} from './platform-http.js';
import {
  PlatformSessionGuard,
  type PlatformRequest,
} from './platform-session.guard.js';
import { addDays, extendedPeriodEnd } from './subscription-math.js';

const OPEN = ['TRIAL', 'ACTIVE', 'PAST_DUE'] as const;

const Start = z.object({
  planId: z.uuid(),
  /** A trial of this many days instead of a paid period. */
  trialDays: z.number().int().min(1).max(365).optional(),
  notes: z.string().trim().max(500).optional(),
});
const ChangePlan = z.object({ planId: z.uuid() });
const Extend = z.object({
  /** Defaults to the plan's period. */
  days: z.number().int().min(1).max(3_660).optional(),
});
const Cancel = z.object({ reason: z.string().trim().min(3).max(500) });
const ManualPayment = z.object({
  amountMinor: z.number().int().positive().max(1e13),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .optional(),
  paidAt: z.iso.datetime().optional(),
  /** Bank or cash reference; unique among MANUAL payments. */
  reference: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(300).optional(),
  /** Extend the open subscription by one plan period. */
  extendSubscription: z.boolean().default(false),
});

type SubscriptionRow = Prisma.TenantSubscriptionGetPayload<{
  include: { plan: { select: { code: true; name: true; periodDays: true } } };
}>;

function view(row: SubscriptionRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    planId: row.planId,
    planCode: row.plan.code,
    planName: row.plan.name,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    graceUntil: row.graceUntil,
    canceledAt: row.canceledAt,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

const PLAN_VIEW = {
  plan: { select: { code: true, name: true, periodDays: true } },
} as const;

/**
 * Subscriptions and MANUAL payments of a tenant (ADR 047 §2, §4). Every
 * write is one platform audit event; the tenant's cached access answer is
 * invalidated in this process.
 */
@Controller('api/v1/platform/tenants/:id')
@UseGuards(PlatformSessionGuard)
export class PlatformBillingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TenantAccessService,
  ) {}

  @Get('subscription')
  async history(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ current: unknown; history: unknown[] }> {
    const rows = await this.prisma.tenantSubscription.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: PLAN_VIEW,
    });
    const open = rows.find((row) =>
      (OPEN as readonly string[]).includes(row.status),
    );
    return { current: open ? view(open) : null, history: rows.map(view) };
  }

  @Post('subscription')
  async start(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parseBody(Start, body);
    const now = new Date();
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await this.requireTenant(tx, id);
        const plan = await tx.subscriptionPlan.findFirst({
          where: { id: input.planId, isActive: true },
        });
        if (!plan) throw notFound();
        if (await this.open(tx, id)) throw conflict('SUBSCRIPTION_OPEN');
        const trial = input.trialDays !== undefined;
        const created = await tx.tenantSubscription.create({
          data: {
            tenantId: id,
            planId: plan.id,
            status: trial ? 'TRIAL' : 'ACTIVE',
            currentPeriodStart: now,
            currentPeriodEnd: addDays(now, input.trialDays ?? plan.periodDays),
            notes: input.notes ?? null,
          },
          include: PLAN_VIEW,
        });
        await recordPlatformAudit(tx, {
          actorAdminId: request.platform!.adminId,
          action: 'subscription.started',
          tenantId: id,
          entityType: 'tenant_subscription',
          entityId: created.id,
          summary: { planCode: plan.code, status: created.status },
        });
        return created;
      });
      this.access.invalidate(id);
      return view(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('SUBSCRIPTION_OPEN');
      throw error;
    }
  }

  @Post('subscription/change-plan')
  async changePlan(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parseBody(ChangePlan, body);
    const row = await this.prisma.$transaction(async (tx) => {
      const open = await this.requireOpen(tx, id);
      const plan = await tx.subscriptionPlan.findFirst({
        where: { id: input.planId, isActive: true },
      });
      if (!plan) throw notFound();
      const updated = await tx.tenantSubscription.update({
        where: { id: open.id },
        data: { planId: plan.id },
        include: PLAN_VIEW,
      });
      await recordPlatformAudit(tx, {
        actorAdminId: request.platform!.adminId,
        action: 'subscription.plan_changed',
        tenantId: id,
        entityType: 'tenant_subscription',
        entityId: open.id,
        summary: { fromPlan: open.plan.code, toPlan: plan.code },
      });
      return updated;
    });
    this.access.invalidate(id);
    return view(row);
  }

  @Post('subscription/extend')
  async extend(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parseBody(Extend, body);
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const open = await this.requireOpen(tx, id);
      const updated = await this.extendOpen(
        tx,
        open,
        input.days ?? open.plan.periodDays,
        now,
        false,
      );
      await recordPlatformAudit(tx, {
        actorAdminId: request.platform!.adminId,
        action: 'subscription.extended',
        tenantId: id,
        entityType: 'tenant_subscription',
        entityId: open.id,
        summary: {
          days: input.days ?? open.plan.periodDays,
          fromStatus: open.status,
          periodEnd: updated.currentPeriodEnd.toISOString(),
        },
      });
      return updated;
    });
    this.access.invalidate(id);
    return view(row);
  }

  @Post('subscription/cancel')
  async cancel(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parseBody(Cancel, body);
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const open = await this.requireOpen(tx, id);
      const updated = await tx.tenantSubscription.update({
        where: { id: open.id },
        data: { status: 'CANCELED', canceledAt: now },
        include: PLAN_VIEW,
      });
      await recordPlatformAudit(tx, {
        actorAdminId: request.platform!.adminId,
        action: 'subscription.canceled',
        tenantId: id,
        entityType: 'tenant_subscription',
        entityId: open.id,
        summary: { reason: input.reason, fromStatus: open.status },
      });
      return updated;
    });
    this.access.invalidate(id);
    return view(row);
  }

  @Get('payments')
  async payments(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ payments: unknown[] }> {
    const rows = await this.prisma.subscriptionPayment.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { recordedBy: { select: { displayName: true } } },
    });
    return {
      payments: rows.map((row) => ({
        id: row.id,
        subscriptionId: row.subscriptionId,
        provider: row.provider,
        providerRef: row.providerRef,
        amountMinor: Number(row.amountMinor),
        currency: row.currency,
        status: row.status,
        paidAt: row.paidAt,
        recordedBy: row.recordedBy?.displayName ?? null,
        summary: row.safeSummary,
        createdAt: row.createdAt,
      })),
    };
  }

  @Post('payments')
  async recordManual(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parseBody(ManualPayment, body);
    const now = new Date();
    const paidAt = input.paidAt ? new Date(input.paidAt) : now;
    try {
      const payment = await this.prisma.$transaction(async (tx) => {
        await this.requireTenant(tx, id);
        const open = await this.open(tx, id);
        if (input.extendSubscription && !open)
          throw conflict('NO_OPEN_SUBSCRIPTION');
        const created = await tx.subscriptionPayment.create({
          data: {
            tenantId: id,
            subscriptionId: open?.id ?? null,
            provider: 'MANUAL',
            providerRef: `manual:${input.reference ?? randomUUID()}`,
            amountMinor: BigInt(input.amountMinor),
            currency: input.currency ?? 'UZS',
            status: 'PAID',
            paidAt,
            recordedById: request.platform!.adminId,
            safeSummary: input.note ? { note: input.note } : {},
          },
        });
        let periodEnd: string | null = null;
        if (input.extendSubscription && open) {
          const extended = await this.extendOpen(
            tx,
            open,
            open.plan.periodDays,
            now,
            true,
          );
          periodEnd = extended.currentPeriodEnd.toISOString();
        }
        await recordPlatformAudit(tx, {
          actorAdminId: request.platform!.adminId,
          action: 'payment.recorded',
          tenantId: id,
          entityType: 'subscription_payment',
          entityId: created.id,
          summary: {
            provider: 'MANUAL',
            amountMinor: input.amountMinor,
            currency: created.currency,
            extended: input.extendSubscription,
            periodEnd,
          },
        });
        return created;
      });
      this.access.invalidate(id);
      return {
        id: payment.id,
        provider: payment.provider,
        providerRef: payment.providerRef,
        amountMinor: Number(payment.amountMinor),
        currency: payment.currency,
        status: payment.status,
        paidAt: payment.paidAt,
      };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('DUPLICATE_PAYMENT');
      throw error;
    }
  }

  private async extendOpen(
    tx: Prisma.TransactionClient,
    open: SubscriptionRow,
    days: number,
    now: Date,
    paid: boolean,
  ): Promise<SubscriptionRow> {
    // An unpaid extension of a trial stays a trial; anything else is ACTIVE.
    return tx.tenantSubscription.update({
      where: { id: open.id },
      data: {
        status: !paid && open.status === 'TRIAL' ? 'TRIAL' : 'ACTIVE',
        graceUntil: null,
        currentPeriodEnd: extendedPeriodEnd(open.currentPeriodEnd, days, now),
      },
      include: PLAN_VIEW,
    });
  }

  private async requireTenant(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<void> {
    const found = await tx.tenant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw notFound();
  }

  private open(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<SubscriptionRow | null> {
    return tx.tenantSubscription.findFirst({
      where: { tenantId: id, status: { in: [...OPEN] } },
      include: PLAN_VIEW,
    });
  }

  private async requireOpen(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<SubscriptionRow> {
    const open = await this.open(tx, id);
    if (!open) throw conflict('NO_OPEN_SUBSCRIPTION');
    return open;
  }
}
