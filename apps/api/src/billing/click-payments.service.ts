import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantAccessService } from '../access/tenant-access.service.js';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import {
  CLICK_ERROR,
  CLICK_ERROR_NOTE,
  buildClickPayLink,
  parseClickAmount,
  parseClickRequest,
  signatureMatches,
  type ClickAnswer,
  type ClickErrorCode,
  type ClickRequest,
} from './click-rules.js';
import { applySubscriptionEntitlement } from './subscription-entitlement.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A pending checkout of the same plan and amount is reused for an hour. */
const REUSE_MS = 60 * 60 * 1000;

export class CheckoutError extends Error {
  constructor(readonly code: 'NOT_CONFIGURED' | 'PLAN_INVALID') {
    super(code);
    this.name = 'CheckoutError';
  }
}

interface Settings {
  readonly serviceId: string;
  readonly merchantId: string;
  readonly secretKey: string;
  readonly merchantUserId: string | undefined;
}

function safeNumber(value: string): number | string {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}

/**
 * Subscription payments through Click (ADR 082). The pay button creates a
 * PENDING payment; Click's Prepare/Complete callbacks confirm it. The
 * callback names no tenant, so one lookup on the privileged connection finds
 * the payment and the work then runs inside that tenant's context (RLS).
 */
@Injectable()
export class ClickPaymentsService {
  private readonly logger = new Logger(ClickPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly privileged: PrivilegedDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly access: TenantAccessService,
  ) {}

  private settings(): Settings | undefined {
    const serviceId = this.config.get('CLICK_SERVICE_ID', { infer: true });
    const merchantId = this.config.get('CLICK_MERCHANT_ID', { infer: true });
    const secretKey = this.config.get('CLICK_SECRET_KEY', { infer: true });
    if (!serviceId || !merchantId || !secretKey) return undefined;
    return {
      serviceId,
      merchantId,
      secretKey,
      merchantUserId: this.config.get('CLICK_MERCHANT_USER_ID', {
        infer: true,
      }),
    };
  }

  get configured(): boolean {
    return this.settings() !== undefined;
  }

  /** Where Click sends the customer back: the public web origin. */
  private returnUrl(): string {
    const origins = this.config.get('WEB_ORIGINS', { infer: true });
    const origin = origins[0] ?? 'http://localhost:3000';
    return `${origin.replace(/\/+$/u, '')}/billing?paid=1`;
  }

  /** Creates (or reuses) the PENDING payment and returns the pay link. */
  async checkout(
    tenantId: string,
    planCode: string,
    now = new Date(),
  ): Promise<{ url: string; paymentId: string }> {
    const settings = this.settings();
    if (!settings) throw new CheckoutError('NOT_CONFIGURED');
    const plan = await this.prisma.subscriptionPlan.findFirst({
      where: { code: planCode, isActive: true, isPublic: true },
    });
    if (!plan || plan.currency !== 'UZS' || plan.priceMinor <= 0n)
      throw new CheckoutError('PLAN_INVALID');
    const recent = await this.prisma.subscriptionPayment.findFirst({
      where: {
        tenantId,
        provider: 'CLICK',
        status: 'PENDING',
        amountMinor: plan.priceMinor,
        createdAt: { gte: new Date(now.getTime() - REUSE_MS) },
        safeSummary: { path: ['planId'], equals: plan.id },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    let paymentId = recent?.id;
    if (!paymentId) {
      paymentId = randomUUID();
      await this.prisma.subscriptionPayment.create({
        data: {
          id: paymentId,
          tenantId,
          provider: 'CLICK',
          providerRef: `click:${paymentId}`,
          amountMinor: plan.priceMinor,
          currency: 'UZS',
          status: 'PENDING',
          safeSummary: {
            planId: plan.id,
            planCode: plan.code,
            periodDays: plan.periodDays,
          },
        },
      });
    }
    return {
      paymentId,
      url: buildClickPayLink({
        serviceId: settings.serviceId,
        merchantId: settings.merchantId,
        merchantUserId: settings.merchantUserId,
        amountMinor: plan.priceMinor,
        paymentId,
        returnUrl: this.returnUrl(),
      }),
    };
  }

  /** Prepare (action 0) and Complete (action 1). Always an answer, never a throw. */
  async handle(body: unknown, complete: boolean): Promise<ClickAnswer> {
    const echo = {
      click_trans_id: safeNumber(
        String((body as Record<string, unknown> | null)?.click_trans_id ?? '0'),
      ),
      merchant_trans_id: String(
        (body as Record<string, unknown> | null)?.merchant_trans_id ?? '',
      ).slice(0, 200),
    };
    const fail = (code: ClickErrorCode): ClickAnswer => ({
      ...echo,
      error: code,
      error_note: CLICK_ERROR_NOTE[code],
    });
    try {
      const outcome = await this.process(body, complete);
      if (typeof outcome === 'number') {
        this.logger.log(
          JSON.stringify({
            event: 'click.callback',
            stage: complete ? 'complete' : 'prepare',
            error: outcome,
          }),
        );
        return fail(outcome);
      }
      return outcome;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'click.callback_failed',
          stage: complete ? 'complete' : 'prepare',
          name: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return fail(CLICK_ERROR.UPDATE_FAILED);
    }
  }

  private async process(
    body: unknown,
    complete: boolean,
  ): Promise<ClickAnswer | ClickErrorCode> {
    const settings = this.settings();
    const request = parseClickRequest(body, complete);
    if (!settings || !request || request.serviceId !== settings.serviceId)
      return CLICK_ERROR.BAD_REQUEST;
    if (!signatureMatches(request, settings.secretKey, complete))
      return CLICK_ERROR.SIGN_CHECK_FAILED;
    if (request.action !== (complete ? '1' : '0'))
      return CLICK_ERROR.ACTION_NOT_FOUND;
    if (!UUID.test(request.merchantTransId)) return CLICK_ERROR.USER_NOT_FOUND;
    // No tenant is known yet: find the payment on the privileged connection.
    const payment = await this.privileged.db.subscriptionPayment.findFirst({
      where: { id: request.merchantTransId.toLowerCase(), provider: 'CLICK' },
    });
    if (!payment) return CLICK_ERROR.USER_NOT_FOUND;
    return runWithTenant(payment.tenantId, () =>
      complete
        ? this.complete(request, payment.id, payment.tenantId)
        : this.prepare(request, payment.id, payment.tenantId),
    );
  }

  private reply(
    request: ClickRequest,
    id: bigint,
    complete: boolean,
  ): ClickAnswer {
    return {
      click_trans_id: safeNumber(request.clickTransId),
      merchant_trans_id: request.merchantTransId,
      ...(complete
        ? { merchant_confirm_id: Number(id) }
        : { merchant_prepare_id: Number(id) }),
      error: CLICK_ERROR.OK,
      error_note: CLICK_ERROR_NOTE[CLICK_ERROR.OK],
    };
  }

  /** The checks shared by both stages, on the payment inside its tenant. */
  private async checked(
    request: ClickRequest,
    paymentId: string,
    tenantId: string,
  ): Promise<
    | ClickErrorCode
    | {
        id: string;
        status: string;
        summary: unknown;
      }
  > {
    const payment = await this.prisma.subscriptionPayment.findFirst({
      where: { id: paymentId, tenantId, provider: 'CLICK' },
    });
    if (!payment) return CLICK_ERROR.USER_NOT_FOUND;
    const amount = parseClickAmount(request.amount);
    if (
      amount === undefined ||
      payment.currency !== 'UZS' ||
      amount !== payment.amountMinor
    )
      return CLICK_ERROR.INCORRECT_AMOUNT;
    if (payment.status === 'PAID') return CLICK_ERROR.ALREADY_PAID;
    if (payment.status !== 'PENDING') return CLICK_ERROR.CANCELLED;
    return {
      id: payment.id,
      status: payment.status,
      summary: payment.safeSummary,
    };
  }

  private async prepare(
    request: ClickRequest,
    paymentId: string,
    tenantId: string,
  ): Promise<ClickAnswer | ClickErrorCode> {
    const found = await this.checked(request, paymentId, tenantId);
    if (typeof found === 'number') return found;
    const clickTransId = BigInt(request.clickTransId);
    const existing = await this.prisma.clickTransaction.findUnique({
      where: { clickTransId },
    });
    if (existing) {
      if (existing.tenantId !== tenantId || existing.paymentId !== paymentId)
        return CLICK_ERROR.BAD_REQUEST;
      if (existing.state === 'CANCELLED') return CLICK_ERROR.CANCELLED;
      if (existing.state === 'CONFIRMED') return CLICK_ERROR.ALREADY_PAID;
      return this.reply(request, existing.id, false);
    }
    const created = await this.prisma.clickTransaction.create({
      data: {
        tenantId,
        paymentId,
        clickTransId,
        clickPaydocId: BigInt(request.clickPaydocId),
      },
    });
    return this.reply(request, created.id, false);
  }

  private async complete(
    request: ClickRequest,
    paymentId: string,
    tenantId: string,
    now = new Date(),
  ): Promise<ClickAnswer | ClickErrorCode> {
    const found = await this.checked(request, paymentId, tenantId);
    if (typeof found === 'number') return found;
    const prepareId = request.merchantPrepareId ?? '';
    if (!/^\d{1,18}$/u.test(prepareId))
      return CLICK_ERROR.TRANSACTION_NOT_FOUND;
    const transaction = await this.prisma.clickTransaction.findFirst({
      where: {
        id: BigInt(prepareId),
        tenantId,
        paymentId,
        clickTransId: BigInt(request.clickTransId),
      },
    });
    if (!transaction) return CLICK_ERROR.TRANSACTION_NOT_FOUND;
    if (transaction.state === 'CANCELLED') return CLICK_ERROR.CANCELLED;
    if (transaction.state === 'CONFIRMED') return CLICK_ERROR.ALREADY_PAID;

    if (Number(request.error) < 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.subscriptionPayment.updateMany({
          where: { id: paymentId, tenantId, status: 'PENDING' },
          data: { status: 'FAILED' },
        });
        await tx.clickTransaction.update({
          where: { id: transaction.id },
          data: { state: 'CANCELLED' },
        });
      });
      return CLICK_ERROR.CANCELLED;
    }

    const summary = (found.summary ?? {}) as { planId?: unknown };
    const planId = typeof summary.planId === 'string' ? summary.planId : '';
    const outcome = await this.prisma.$transaction(async (tx) => {
      // Only one concurrent Complete wins this update.
      const won = await tx.subscriptionPayment.updateMany({
        where: { id: paymentId, tenantId, status: 'PENDING' },
        data: { status: 'PAID', paidAt: now },
      });
      if (won.count !== 1) return 'RACED' as const;
      const applied = await applySubscriptionEntitlement(tx, {
        tenantId,
        paymentId,
        planId,
        now,
      });
      await tx.clickTransaction.update({
        where: { id: transaction.id },
        data: { state: 'CONFIRMED', confirmedAt: now },
      });
      await tx.platformAuditEvent.create({
        data: {
          actorAdminId: null,
          action: 'payment.click_confirmed',
          tenantId,
          entityType: 'subscription_payment',
          entityId: paymentId,
          safeSummary: {
            provider: 'CLICK',
            planCode: applied.planCode,
            amountMinor: Number(applied.planPriceMinor),
            periodEnd: applied.periodEnd.toISOString(),
            wasOpen: applied.wasOpen,
          },
        },
      });
      return 'PAID' as const;
    });
    if (outcome === 'RACED') return CLICK_ERROR.ALREADY_PAID;
    this.access.invalidate(tenantId);
    return this.reply(request, transaction.id, true);
  }
}
