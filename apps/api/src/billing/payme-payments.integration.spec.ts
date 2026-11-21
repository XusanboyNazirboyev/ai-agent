/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { TenantAccessService } from '../access/tenant-access.service.js';
import type { AppEnvironment } from '../config/environment.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import type { PrivilegedDatabase } from '../persistence/privileged-database.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { PaymePaymentsService } from './payme-payments.service.js';

/** ADR 084 against PostgreSQL; Payme itself is simulated with official RPCs. */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Payme tests require agentcore_test');

const db = ownerClient();
const app = appClient();
const LOGIN = 'Paycom-test';
const KEY = `key-${randomUUID()}`;
const MERCHANT = '507f1f77bcf86cd799439011';
const settings: Record<string, unknown> = {
  PAYME_MERCHANT_ID: MERCHANT,
  PAYME_LOGIN: LOGIN,
  PAYME_KEY: KEY,
  WEB_ORIGINS: ['https://app.example.test'],
};
const config = {
  get: (key: string) => settings[key],
} as unknown as ConfigService<AppEnvironment, true>;
const invalidate = vi.fn();
const service = new PaymePaymentsService(
  app as unknown as PrismaService,
  { db } as unknown as PrivilegedDatabase,
  config,
  { invalidate } as unknown as TenantAccessService,
);
const scoped = tenantScoped(service, { tenantArg: 0 });
const AUTH = `Basic ${Buffer.from(`${LOGIN}:${KEY}`).toString('base64')}`;

afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

async function plan(price = 15_000_000n) {
  return db.subscriptionPlan.create({
    data: {
      code: `payme-${randomUUID().slice(0, 8)}`,
      name: 'Payme plan',
      priceMinor: price,
      periodDays: 30,
      isPublic: true,
    },
  });
}

async function tenant() {
  return db.tenant.create({
    data: {
      slug: `payme-${randomUUID()}`,
      name: 'Payme fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
}

async function order(price = 15_000_000n) {
  const t = await tenant();
  const p = await plan(price);
  const checkout = await scoped.checkout(t.id, p.code, 'uz');
  return { t, p, ...checkout, amount: Number(price) };
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  authorization = AUTH,
) {
  return service.handle(
    { jsonrpc: '2.0', id: 7, method, params },
    authorization,
  );
}

function transactionId(): string {
  return randomBytes(12).toString('hex');
}

function params(o: Awaited<ReturnType<typeof order>>, id: string) {
  return {
    id,
    time: Date.now(),
    amount: o.amount,
    account: { order_id: o.paymentId },
  };
}

function answerResult(answer: Awaited<ReturnType<typeof rpc>>) {
  if (!('result' in answer)) throw new Error('Expected Payme result');
  return answer.result as Record<string, unknown>;
}

describe('Payme checkout', () => {
  it('creates one PENDING order and a documented production link', async () => {
    const o = await order();
    const row = await db.subscriptionPayment.findUniqueOrThrow({
      where: { id: o.paymentId },
    });
    expect(row).toMatchObject({
      tenantId: o.t.id,
      provider: 'PAYME',
      status: 'PENDING',
      amountMinor: 15_000_000n,
    });
    expect(o.url.startsWith('https://checkout.paycom.uz/')).toBe(true);
    const decoded = Buffer.from(
      o.url.slice('https://checkout.paycom.uz/'.length),
      'base64',
    ).toString('utf8');
    expect(decoded).toContain(`m=${MERCHANT}`);
    expect(decoded).toContain(`ac.order_id=${o.paymentId}`);
    expect(decoded).toContain('a=15000000');
    expect(decoded).toContain('l=uz');
    expect(decoded).not.toContain(KEY);
    expect((await scoped.checkout(o.t.id, o.p.code, 'en')).paymentId).toBe(
      o.paymentId,
    );
  });
});

describe('Payme Merchant API', () => {
  it('authenticates, performs idempotently, reports, and refunds exactly once', async () => {
    const o = await order();
    const end = new Date(Date.now() + 5 * 86_400_000);
    const sub = await db.tenantSubscription.create({
      data: {
        tenantId: o.t.id,
        planId: o.p.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: end,
      },
    });
    const id = transactionId();
    const createParams = params(o, id);
    const denied = await rpc('CheckPerformTransaction', createParams, '');
    expect('error' in denied && denied.error.code).toBe(-32504);
    expect(await rpc('CheckPerformTransaction', createParams)).toMatchObject({
      result: { allow: true },
    });

    const created = answerResult(await rpc('CreateTransaction', createParams));
    expect(created).toMatchObject({ state: 1, transaction: o.paymentId });
    expect(Object.keys(created).sort()).toEqual([
      'create_time',
      'state',
      'transaction',
    ]);
    expect(answerResult(await rpc('CreateTransaction', createParams))).toEqual(
      created,
    );

    const performed = answerResult(await rpc('PerformTransaction', { id }));
    expect(performed).toMatchObject({ state: 2, transaction: o.paymentId });
    expect(Object.keys(performed).sort()).toEqual([
      'perform_time',
      'state',
      'transaction',
    ]);
    expect(answerResult(await rpc('PerformTransaction', { id }))).toEqual(
      performed,
    );
    const after = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.currentPeriodEnd.getTime()).toBe(
      end.getTime() + 30 * 86_400_000,
    );
    expect(
      await db.platformAuditEvent.count({
        where: { tenantId: o.t.id, action: 'payment.payme_performed' },
      }),
    ).toBe(1);

    expect(await rpc('CheckTransaction', { id })).toMatchObject({
      result: { state: 2, transaction: o.paymentId },
    });
    const statement = answerResult(
      await rpc('GetStatement', {
        from: createParams.time - 1,
        to: createParams.time + 1,
      }),
    );
    expect(statement.transactions).toEqual([
      expect.objectContaining({
        id,
        amount: o.amount,
        account: { order_id: o.paymentId },
        state: 2,
      }),
    ]);

    const cancelled = answerResult(
      await rpc('CancelTransaction', { id, reason: 5 }),
    );
    expect(cancelled).toMatchObject({ state: -2 });
    expect(Object.keys(cancelled).sort()).toEqual([
      'cancel_time',
      'state',
      'transaction',
    ]);
    expect(
      answerResult(await rpc('CancelTransaction', { id, reason: 5 })),
    ).toEqual(cancelled);
    expect(await rpc('CheckTransaction', { id })).toMatchObject({
      result: { state: -2, reason: 5 },
    });
    const restored = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(restored.currentPeriodEnd.getTime()).toBe(end.getTime());
    const payment = await db.subscriptionPayment.findUniqueOrThrow({
      where: { id: o.paymentId },
    });
    expect(payment.status).toBe('REFUNDED');
    expect(
      await db.platformAuditEvent.count({
        where: { tenantId: o.t.id, action: 'payment.payme_refunded' },
      }),
    ).toBe(1);
    expect(invalidate).toHaveBeenCalledWith(o.t.id);
  });

  it('cancels a created order and rejects a timed-out Perform', async () => {
    const cancelledOrder = await order();
    const firstId = transactionId();
    await rpc('CreateTransaction', params(cancelledOrder, firstId));
    expect(
      answerResult(await rpc('CancelTransaction', { id: firstId, reason: 3 })),
    ).toMatchObject({ state: -1 });
    expect(await rpc('PerformTransaction', { id: firstId })).toMatchObject({
      error: { code: -31008 },
    });

    const oldOrder = await order();
    const oldId = transactionId();
    const old = {
      ...params(oldOrder, oldId),
      time: Date.now() - 43_200_001,
    };
    await rpc('CreateTransaction', old);
    expect(await rpc('PerformTransaction', { id: oldId })).toMatchObject({
      error: { code: -31008 },
    });
    expect(await rpc('CheckTransaction', { id: oldId })).toMatchObject({
      result: { state: -1, reason: 4 },
    });
  });

  it('refunds the first paid period without leaving an active subscription', async () => {
    const o = await order();
    const id = transactionId();
    await rpc('CreateTransaction', params(o, id));
    await rpc('PerformTransaction', { id });
    await rpc('CancelTransaction', { id, reason: 5 });
    const rows = await db.tenantSubscription.findMany({
      where: { tenantId: o.t.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'CANCELED', planId: o.p.id });
    expect(rows[0]!.currentPeriodEnd.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('does not accept a wrong amount, account, method, or reused transaction id', async () => {
    const one = await order();
    const two = await order();
    const id = transactionId();
    const first = params(one, id);
    expect(
      await rpc('CheckPerformTransaction', {
        ...first,
        amount: one.amount + 1,
      }),
    ).toMatchObject({ error: { code: -31001 } });
    expect(
      await rpc('CheckPerformTransaction', {
        ...first,
        account: { order_id: randomUUID() },
      }),
    ).toMatchObject({ error: { code: -31050, data: 'order_id' } });
    expect(await rpc('Unknown', {})).toMatchObject({
      error: { code: -32601, data: 'Unknown' },
    });
    await rpc('CreateTransaction', first);
    expect(
      await rpc('CreateTransaction', {
        ...params(two, id),
        time: first.time,
      }),
    ).toMatchObject({ error: { code: -31008 } });
  });

  it('two concurrent Perform calls extend the subscription once', async () => {
    const o = await order();
    const id = transactionId();
    await rpc('CreateTransaction', params(o, id));
    const answers = await Promise.all([
      rpc('PerformTransaction', { id }),
      rpc('PerformTransaction', { id }),
    ]);
    expect(answers).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ state: 2 }),
      }),
      expect.objectContaining({
        result: expect.objectContaining({ state: 2 }),
      }),
    ]);
    expect(
      await db.platformAuditEvent.count({
        where: { tenantId: o.t.id, action: 'payment.payme_performed' },
      }),
    ).toBe(1);
  });

  it('refunding an older payment preserves a later paid extension', async () => {
    const first = await order();
    const end = new Date(Date.now() + 2 * 86_400_000);
    const sub = await db.tenantSubscription.create({
      data: {
        tenantId: first.t.id,
        planId: first.p.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: end,
      },
    });
    const secondCheckout = await scoped.checkout(
      first.t.id,
      first.p.code,
      'en',
      new Date(Date.now() + 2 * 60 * 60 * 1000),
    );
    const firstId = transactionId();
    await rpc('CreateTransaction', params(first, firstId));
    await rpc('PerformTransaction', { id: firstId });
    const second = {
      ...first,
      paymentId: secondCheckout.paymentId,
      url: secondCheckout.url,
    };
    const secondId = transactionId();
    await rpc('CreateTransaction', params(second, secondId));
    await rpc('PerformTransaction', { id: secondId });
    const twice = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(twice.currentPeriodEnd.getTime()).toBe(
      end.getTime() + 60 * 86_400_000,
    );

    await rpc('CancelTransaction', { id: firstId, reason: 5 });
    const once = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(once.currentPeriodEnd.getTime()).toBe(
      end.getTime() + 30 * 86_400_000,
    );
    expect(
      await db.subscriptionPayment.findUniqueOrThrow({
        where: { id: second.paymentId },
      }),
    ).toMatchObject({ status: 'PAID', subscriptionId: sub.id });

    await rpc('CancelTransaction', { id: secondId, reason: 5 });
    const none = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(none.currentPeriodEnd.getTime()).toBe(end.getTime());
    expect(none).toMatchObject({ status: 'ACTIVE', planId: first.p.id });
  });
});
