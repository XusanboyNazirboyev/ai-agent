import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantAccessService } from '../access/tenant-access.service.js';
import type { AppEnvironment } from '../config/environment.js';
import type { PaymeTransaction, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import { CheckoutError } from './click-payments.service.js';
import {
  PAYME_ERROR,
  PAYME_TRANSACTION_TIMEOUT_MS,
  buildPaymeCheckoutLink,
  paymeAuthorizationMatches,
  paymeError,
  type PaymeError,
} from './payme-rules.js';
import {
  applySubscriptionEntitlement,
  parseEntitlementSnapshot,
  reverseSubscriptionEntitlement,
} from './subscription-entitlement.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PAYME_ID = /^[0-9a-f]{24}$/iu;
const REUSE_MS = 60 * 60 * 1000;
const CANCEL_REASONS = new Set([1, 2, 3, 4, 5, 10]);

interface Settings {
  readonly merchantId: string;
  readonly login: string;
  readonly key: string;
}

type RpcId = string | number | null;
interface RpcRequest {
  readonly id: RpcId;
  readonly method: string;
  readonly params: Record<string, unknown>;
}
export type PaymeAnswer =
  | { readonly jsonrpc: '2.0'; readonly id: RpcId; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: RpcId; readonly error: PaymeError };

function rpc(body: unknown): RpcRequest | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return undefined;
  const row = body as Record<string, unknown>;
  const id = row.id;
  if (
    row.jsonrpc !== '2.0' ||
    (typeof id !== 'string' && typeof id !== 'number' && id !== null) ||
    typeof row.method !== 'string' ||
    !row.params ||
    typeof row.params !== 'object' ||
    Array.isArray(row.params)
  )
    return undefined;
  return {
    id,
    method: row.method,
    params: row.params as Record<string, unknown>,
  };
}

function requestId(body: unknown): RpcId {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' || id === null
    ? id
    : null;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  const parsed = integer(value);
  return parsed !== undefined && parsed >= 1_000_000_000_000
    ? parsed
    : undefined;
}

function transactionId(params: Record<string, unknown>): string | undefined {
  return typeof params.id === 'string' && PAYME_ID.test(params.id)
    ? params.id.toLowerCase()
    : undefined;
}

function orderId(params: Record<string, unknown>): string | undefined {
  const account = params.account;
  if (!account || typeof account !== 'object' || Array.isArray(account))
    return undefined;
  const value = (account as Record<string, unknown>).order_id;
  return typeof value === 'string' && UUID.test(value)
    ? value.toLowerCase()
    : undefined;
}

function createResult(row: PaymeTransaction): Record<string, unknown> {
  return {
    create_time: Number(row.createTime),
    transaction: row.paymentId,
    state: row.state,
  };
}

function performResult(row: PaymeTransaction): Record<string, unknown> {
  return {
    transaction: row.paymentId,
    perform_time: Number(row.performTime),
    state: row.state,
  };
}

function cancelResult(row: PaymeTransaction): Record<string, unknown> {
  return {
    transaction: row.paymentId,
    cancel_time: Number(row.cancelTime),
    state: row.state,
  };
}

function checkResult(row: PaymeTransaction): Record<string, unknown> {
  return {
    create_time: Number(row.createTime),
    perform_time: Number(row.performTime),
    cancel_time: Number(row.cancelTime),
    transaction: row.paymentId,
    state: row.state,
    reason: row.reason,
  };
}

/** Payme checkout and required Merchant API methods (ADR 084). */
@Injectable()
export class PaymePaymentsService {
  private readonly logger = new Logger(PaymePaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly privileged: PrivilegedDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly access: TenantAccessService,
  ) {}

  private settings(): Settings | undefined {
    const merchantId = this.config.get('PAYME_MERCHANT_ID', { infer: true });
    const login = this.config.get('PAYME_LOGIN', { infer: true });
    const key = this.config.get('PAYME_KEY', { infer: true });
    return merchantId && login && key ? { merchantId, login, key } : undefined;
  }

  get configured(): boolean {
    return this.settings() !== undefined;
  }

  private returnUrl(): string {
    const origins = this.config.get('WEB_ORIGINS', { infer: true });
    const origin = origins[0] ?? 'http://localhost:3000';
    return `${origin.replace(/\/+$/u, '')}/settings/subscription?paid=1`;
  }

  async checkout(
    tenantId: string,
    planCode: string,
    locale: 'en' | 'ru' | 'uz',
    now = new Date(),
  ): Promise<{ url: string; paymentId: string }> {
    const settings = this.settings();
    if (!settings) throw new CheckoutError('NOT_CONFIGURED');
    const plan = await this.prisma.subscriptionPlan.findFirst({
      where: { code: planCode, isActive: true, isPublic: true },
    });
    if (
      !plan ||
      plan.currency !== 'UZS' ||
      plan.priceMinor <= 0n ||
      plan.priceMinor > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new CheckoutError('PLAN_INVALID');
    const recent = await this.prisma.subscriptionPayment.findFirst({
      where: {
        tenantId,
        provider: 'PAYME',
        status: 'PENDING',
        amountMinor: plan.priceMinor,
        createdAt: { gte: new Date(now.getTime() - REUSE_MS) },
        safeSummary: { path: ['planId'], equals: plan.id },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const paymentId = recent?.id ?? randomUUID();
    if (!recent)
      await this.prisma.subscriptionPayment.create({
        data: {
          id: paymentId,
          tenantId,
          provider: 'PAYME',
          providerRef: `payme:${paymentId}`,
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
    return {
      paymentId,
      url: buildPaymeCheckoutLink({
        merchantId: settings.merchantId,
        paymentId,
        amountMinor: plan.priceMinor,
        locale,
        returnUrl: this.returnUrl(),
      }),
    };
  }

  async handle(body: unknown, authorization?: string): Promise<PaymeAnswer> {
    const id = requestId(body);
    const settings = this.settings();
    if (
      !settings ||
      !paymeAuthorizationMatches(authorization, settings.login, settings.key)
    )
      return { jsonrpc: '2.0', id, error: paymeError(PAYME_ERROR.AUTH) };
    const request = rpc(body);
    if (!request)
      return {
        jsonrpc: '2.0',
        id,
        error: paymeError(PAYME_ERROR.INVALID_REQUEST),
      };
    try {
      const value = await this.dispatch(request);
      return 'code' in value
        ? { jsonrpc: '2.0', id: request.id, error: value }
        : { jsonrpc: '2.0', id: request.id, result: value.result };
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'payme.callback_failed',
          method: request.method,
          name: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: paymeError(PAYME_ERROR.INTERNAL),
      };
    }
  }

  /** Payme defines a JSON-RPC error for any HTTP method other than POST. */
  wrongHttpMethod(body: unknown, authorization?: string): PaymeAnswer {
    const id = requestId(body);
    const settings = this.settings();
    const error =
      settings &&
      paymeAuthorizationMatches(authorization, settings.login, settings.key)
        ? paymeError(PAYME_ERROR.HTTP_METHOD)
        : paymeError(PAYME_ERROR.AUTH);
    return { jsonrpc: '2.0', id, error };
  }

  private async dispatch(
    request: RpcRequest,
  ): Promise<PaymeError | { result: unknown }> {
    switch (request.method) {
      case 'CheckPerformTransaction':
        return this.checkPerform(request.params);
      case 'CreateTransaction':
        return this.create(request.params);
      case 'PerformTransaction':
        return this.perform(request.params);
      case 'CancelTransaction':
        return this.cancel(request.params);
      case 'CheckTransaction':
        return this.check(request.params);
      case 'GetStatement':
        return this.statement(request.params);
      default:
        return paymeError(PAYME_ERROR.METHOD_NOT_FOUND, request.method);
    }
  }

  private async payment(
    params: Record<string, unknown>,
  ): Promise<
    PaymeError | { tenantId: string; paymentId: string; amount: number }
  > {
    const paymentId = orderId(params);
    if (!paymentId)
      return paymeError(PAYME_ERROR.ACCOUNT_NOT_FOUND, 'order_id');
    const amount = integer(params.amount);
    if (amount === undefined || amount === 0)
      return paymeError(PAYME_ERROR.INVALID_AMOUNT);
    const found = await this.privileged.db.subscriptionPayment.findFirst({
      where: { id: paymentId, provider: 'PAYME' },
      select: { tenantId: true },
    });
    if (!found) return paymeError(PAYME_ERROR.ACCOUNT_NOT_FOUND, 'order_id');
    return runWithTenant(found.tenantId, async () => {
      const scoped = await this.prisma.subscriptionPayment.findFirst({
        where: { id: paymentId, tenantId: found.tenantId, provider: 'PAYME' },
      });
      if (!scoped) return paymeError(PAYME_ERROR.ACCOUNT_NOT_FOUND, 'order_id');
      if (scoped.currency !== 'UZS' || BigInt(amount) !== scoped.amountMinor)
        return paymeError(PAYME_ERROR.INVALID_AMOUNT);
      if (scoped.status !== 'PENDING') return paymeError(PAYME_ERROR.UNABLE);
      return { tenantId: found.tenantId, paymentId, amount };
    });
  }

  private async checkPerform(
    params: Record<string, unknown>,
  ): Promise<PaymeError | { result: unknown }> {
    const payment = await this.payment(params);
    return 'code' in payment ? payment : { result: { allow: true } };
  }

  private async create(
    params: Record<string, unknown>,
    now = new Date(),
  ): Promise<PaymeError | { result: unknown }> {
    const id = transactionId(params);
    const time = timestamp(params.time);
    if (!id || time === undefined)
      return paymeError(PAYME_ERROR.INVALID_REQUEST);
    const requestedPaymentId = orderId(params);
    if (!requestedPaymentId)
      return paymeError(PAYME_ERROR.ACCOUNT_NOT_FOUND, 'order_id');
    const requestedAmount = integer(params.amount);
    if (requestedAmount === undefined || requestedAmount === 0)
      return paymeError(PAYME_ERROR.INVALID_AMOUNT);
    const known = await this.privileged.db.paymeTransaction.findUnique({
      where: { id },
    });
    if (known) {
      if (
        known.paymentId !== requestedPaymentId ||
        known.paymeTime !== BigInt(time) ||
        known.amountMinor !== BigInt(requestedAmount)
      )
        return paymeError(PAYME_ERROR.UNABLE);
      return runWithTenant(known.tenantId, async () => ({
        result: createResult(await this.expire(known, now)),
      }));
    }
    const payment = await this.payment(params);
    if ('code' in payment) return payment;
    return runWithTenant(payment.tenantId, async () => {
      const forPayment = await this.prisma.paymeTransaction.findUnique({
        where: { paymentId: payment.paymentId },
      });
      if (forPayment) return paymeError(PAYME_ERROR.UNABLE);
      try {
        const created = await this.prisma.paymeTransaction.create({
          data: {
            id,
            tenantId: payment.tenantId,
            paymentId: payment.paymentId,
            paymeTime: BigInt(time),
            amountMinor: BigInt(payment.amount),
            state: 1,
            createTime: BigInt(now.getTime()),
          },
        });
        return { result: createResult(created) };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2002'
        )
          return paymeError(PAYME_ERROR.UNABLE);
        throw error;
      }
    });
  }

  private async expire(
    row: PaymeTransaction,
    now: Date,
  ): Promise<PaymeTransaction> {
    if (
      row.state !== 1 ||
      now.getTime() - Number(row.paymeTime) < PAYME_TRANSACTION_TIMEOUT_MS
    )
      return row;
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.paymeTransaction.updateMany({
        where: { id: row.id, tenantId: row.tenantId, state: 1 },
        data: { state: -1, reason: 4, cancelTime: BigInt(now.getTime()) },
      });
      if (changed.count === 1)
        await tx.subscriptionPayment.updateMany({
          where: {
            id: row.paymentId,
            tenantId: row.tenantId,
            status: 'PENDING',
          },
          data: { status: 'FAILED' },
        });
      return tx.paymeTransaction.findUniqueOrThrow({ where: { id: row.id } });
    });
  }

  private async findTransaction(
    params: Record<string, unknown>,
  ): Promise<PaymeError | PaymeTransaction> {
    const id = transactionId(params);
    if (!id) return paymeError(PAYME_ERROR.INVALID_REQUEST);
    return (
      (await this.privileged.db.paymeTransaction.findUnique({
        where: { id },
      })) ?? paymeError(PAYME_ERROR.TRANSACTION_NOT_FOUND)
    );
  }

  private async perform(
    params: Record<string, unknown>,
    now = new Date(),
  ): Promise<PaymeError | { result: unknown }> {
    const found = await this.findTransaction(params);
    if ('code' in found) return found;
    if (found.state === 2) return { result: performResult(found) };
    if (found.state !== 1) return paymeError(PAYME_ERROR.UNABLE);
    return runWithTenant(found.tenantId, async () => {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const row = await tx.paymeTransaction.findUniqueOrThrow({
          where: { id: found.id },
        });
        if (row.state === 2) return { kind: 'DONE' as const, row };
        if (row.state !== 1) return { kind: 'UNABLE' as const };
        if (
          now.getTime() - Number(row.paymeTime) >=
          PAYME_TRANSACTION_TIMEOUT_MS
        ) {
          await tx.paymeTransaction.update({
            where: { id: row.id },
            data: {
              state: -1,
              reason: 4,
              cancelTime: BigInt(now.getTime()),
            },
          });
          await tx.subscriptionPayment.updateMany({
            where: {
              id: row.paymentId,
              tenantId: row.tenantId,
              status: 'PENDING',
            },
            data: { status: 'FAILED' },
          });
          return { kind: 'UNABLE' as const };
        }
        const won = await tx.paymeTransaction.updateMany({
          where: { id: row.id, tenantId: row.tenantId, state: 1 },
          data: { state: 2, performTime: BigInt(now.getTime()) },
        });
        if (won.count !== 1) return { kind: 'RACED' as const };
        const paid = await tx.subscriptionPayment.updateMany({
          where: {
            id: row.paymentId,
            tenantId: row.tenantId,
            status: 'PENDING',
          },
          data: { status: 'PAID', paidAt: now },
        });
        if (paid.count !== 1) throw new Error('PAYMENT_STATE_INVALID');
        const payment = await tx.subscriptionPayment.findUniqueOrThrow({
          where: { id: row.paymentId },
        });
        const summary = (payment.safeSummary ?? {}) as { planId?: unknown };
        const planId = typeof summary.planId === 'string' ? summary.planId : '';
        const applied = await applySubscriptionEntitlement(tx, {
          tenantId: row.tenantId,
          paymentId: row.paymentId,
          planId,
          now,
        });
        const saved = await tx.paymeTransaction.update({
          where: { id: row.id },
          data: {
            entitlementSnapshot:
              applied.snapshot as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.platformAuditEvent.create({
          data: {
            actorAdminId: null,
            action: 'payment.payme_performed',
            tenantId: row.tenantId,
            entityType: 'subscription_payment',
            entityId: row.paymentId,
            safeSummary: {
              provider: 'PAYME',
              planCode: applied.planCode,
              amountMinor: Number(applied.planPriceMinor),
              periodEnd: applied.periodEnd.toISOString(),
              wasOpen: applied.wasOpen,
            },
          },
        });
        return { kind: 'DONE' as const, row: saved };
      });
      if (outcome.kind === 'UNABLE') return paymeError(PAYME_ERROR.UNABLE);
      if (outcome.kind === 'RACED') {
        const raced = await this.prisma.paymeTransaction.findUniqueOrThrow({
          where: { id: found.id },
        });
        return raced.state === 2
          ? { result: performResult(raced) }
          : paymeError(PAYME_ERROR.UNABLE);
      }
      this.access.invalidate(found.tenantId);
      return { result: performResult(outcome.row) };
    });
  }

  private async cancel(
    params: Record<string, unknown>,
    now = new Date(),
  ): Promise<PaymeError | { result: unknown }> {
    const reason = integer(params.reason);
    if (reason === undefined || !CANCEL_REASONS.has(reason))
      return paymeError(PAYME_ERROR.INVALID_REQUEST);
    const found = await this.findTransaction(params);
    if ('code' in found) return found;
    if (found.state === -1 || found.state === -2)
      return { result: cancelResult(found) };
    return runWithTenant(found.tenantId, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await this.prisma.$transaction(async (tx) => {
          const row = await tx.paymeTransaction.findUniqueOrThrow({
            where: { id: found.id },
          });
          if (row.state === -1 || row.state === -2)
            return { kind: 'DONE' as const, row, refunded: row.state === -2 };
          if (row.state !== 1 && row.state !== 2)
            return { kind: 'UNABLE' as const };
          const nextState = row.state === 1 ? -1 : -2;
          const won = await tx.paymeTransaction.updateMany({
            where: { id: row.id, tenantId: row.tenantId, state: row.state },
            data: {
              state: nextState,
              reason,
              cancelTime: BigInt(now.getTime()),
            },
          });
          if (won.count !== 1) return { kind: 'RACED' as const };
          if (row.state === 1) {
            await tx.subscriptionPayment.updateMany({
              where: {
                id: row.paymentId,
                tenantId: row.tenantId,
                status: 'PENDING',
              },
              data: { status: 'FAILED' },
            });
          } else {
            const snapshot = parseEntitlementSnapshot(row.entitlementSnapshot);
            if (!snapshot) throw new Error('ENTITLEMENT_SNAPSHOT_INVALID');
            const refunded = await tx.subscriptionPayment.updateMany({
              where: {
                id: row.paymentId,
                tenantId: row.tenantId,
                status: 'PAID',
              },
              data: { status: 'REFUNDED' },
            });
            if (refunded.count !== 1) throw new Error('PAYMENT_STATE_INVALID');
            await reverseSubscriptionEntitlement(tx, {
              tenantId: row.tenantId,
              paymentId: row.paymentId,
              snapshot,
              now,
            });
          }
          await tx.platformAuditEvent.create({
            data: {
              actorAdminId: null,
              action:
                row.state === 2
                  ? 'payment.payme_refunded'
                  : 'payment.payme_cancelled',
              tenantId: row.tenantId,
              entityType: 'subscription_payment',
              entityId: row.paymentId,
              safeSummary: { provider: 'PAYME', reason },
            },
          });
          const saved = await tx.paymeTransaction.findUniqueOrThrow({
            where: { id: row.id },
          });
          return {
            kind: 'DONE' as const,
            row: saved,
            refunded: row.state === 2,
          };
        });
        if (outcome.kind === 'RACED') continue;
        if (outcome.kind === 'UNABLE') return paymeError(PAYME_ERROR.UNABLE);
        if (outcome.refunded) this.access.invalidate(found.tenantId);
        return { result: cancelResult(outcome.row) };
      }
      return paymeError(PAYME_ERROR.UNABLE);
    });
  }

  private async check(
    params: Record<string, unknown>,
  ): Promise<PaymeError | { result: unknown }> {
    const found = await this.findTransaction(params);
    return 'code' in found ? found : { result: checkResult(found) };
  }

  private async statement(
    params: Record<string, unknown>,
  ): Promise<PaymeError | { result: unknown }> {
    const from = integer(params.from);
    const to = integer(params.to);
    if (from === undefined || to === undefined || from > to)
      return paymeError(PAYME_ERROR.INVALID_REQUEST);
    const rows = await this.privileged.db.paymeTransaction.findMany({
      where: { paymeTime: { gte: BigInt(from), lte: BigInt(to) } },
      orderBy: [{ paymeTime: 'asc' }, { id: 'asc' }],
    });
    return {
      result: {
        transactions: rows.map((row) => ({
          id: row.id,
          time: Number(row.paymeTime),
          amount: Number(row.amountMinor),
          account: { order_id: row.paymentId },
          ...checkResult(row),
        })),
      },
    };
  }
}
