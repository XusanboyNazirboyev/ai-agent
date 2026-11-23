/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
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
import { ClickPaymentsService } from './click-payments.service.js';

/** ADR 082 against the real database; Click itself is simulated (no test service available). */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Click tests require agentcore_test');

const db = ownerClient();
const app = appClient();
const SECRET = `sk-${randomUUID()}`;
const SERVICE = '4242';
const settings: Record<string, unknown> = {
  CLICK_SERVICE_ID: SERVICE,
  CLICK_MERCHANT_ID: '777',
  CLICK_SECRET_KEY: SECRET,
  WEB_ORIGINS: ['https://app.example.test'],
};
const config = {
  get: (key: string) => settings[key],
} as unknown as ConfigService<AppEnvironment, true>;
const invalidate = vi.fn();
const logs: string[] = [];
const service = new ClickPaymentsService(
  app as unknown as PrismaService,
  { db } as unknown as PrivilegedDatabase,
  config,
  { invalidate } as unknown as TenantAccessService,
);
const serviceLogger = (
  service as unknown as { logger: Record<string, unknown> }
).logger;
for (const level of ['log', 'warn', 'error'])
  serviceLogger[level] = (message: unknown): void => {
    logs.push(String(message));
  };
const scoped = tenantScoped(service, { tenantArg: 0 });

afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const suffix = randomUUID().slice(0, 8);
const md5 = (text: string) => createHash('md5').update(text).digest('hex');
let trans = 9_000_000 + (Date.now() % 1_000_000);

async function plan(price = 15000000n, extra: object = {}) {
  return db.subscriptionPlan.create({
    data: {
      code: `click-${suffix}-${randomUUID().slice(0, 6)}`,
      name: 'Click plan',
      priceMinor: price,
      periodDays: 30,
      isPublic: true,
      ...extra,
    },
  });
}
async function tenant() {
  return db.tenant.create({
    data: {
      slug: `click-${randomUUID()}`,
      name: 'Click fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
}

interface Call {
  merchant_trans_id: string;
  amount: string;
  action?: string;
  error?: string;
  prepare?: string;
  service?: string;
  secret?: string;
  tid?: number;
}
function form(call: Call, complete: boolean) {
  const clickTransId = String(call.tid ?? ++trans);
  const action = call.action ?? (complete ? '1' : '0');
  const signTime = '2026-11-19 10:00:00';
  const serviceId = call.service ?? SERVICE;
  const sign = md5(
    clickTransId +
      serviceId +
      (call.secret ?? SECRET) +
      call.merchant_trans_id +
      (complete ? (call.prepare ?? '') : '') +
      call.amount +
      action +
      signTime,
  );
  return {
    click_trans_id: clickTransId,
    service_id: serviceId,
    click_paydoc_id: '555',
    merchant_trans_id: call.merchant_trans_id,
    ...(complete ? { merchant_prepare_id: call.prepare ?? '' } : {}),
    amount: call.amount,
    action,
    error: call.error ?? '0',
    sign_time: signTime,
    sign_string: sign,
  };
}
const prepare = (call: Call) => service.handle(form(call, false), false);
const complete = (call: Call) => service.handle(form(call, true), true);

async function order(price = 15000000n) {
  const t = await tenant();
  const p = await plan(price);
  const { url, paymentId } = await scoped.checkout(t.id, p.code);
  return { t, p, url, paymentId, amount: `${price / 100n}.00` };
}

describe('Click checkout', () => {
  it('creates a PENDING CLICK payment and the documented link', async () => {
    const o = await order();
    const row = await db.subscriptionPayment.findUniqueOrThrow({
      where: { id: o.paymentId },
    });
    expect(row).toMatchObject({
      provider: 'CLICK',
      status: 'PENDING',
      amountMinor: 15000000n,
      currency: 'UZS',
      tenantId: o.t.id,
    });
    const url = new URL(o.url);
    expect(url.origin + url.pathname).toBe('https://my.click.uz/services/pay/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      service_id: SERVICE,
      merchant_id: '777',
      amount: '150000.00',
      transaction_param: o.paymentId,
      return_url: 'https://app.example.test/billing?paid=1',
    });
    expect(o.url).not.toContain(SECRET);
    // A second press reuses the open order.
    const again = await scoped.checkout(o.t.id, o.p.code);
    expect(again.paymentId).toBe(o.paymentId);
  });

  it('refuses unknown, private, inactive and non-UZS plans and an unconfigured Click', async () => {
    const t = await tenant();
    const priv = await plan(100n, { isPublic: false });
    const off = await plan(100n, { isActive: false });
    const usd = await plan(100n, { currency: 'USD' });
    for (const code of ['nope', priv.code, off.code, usd.code])
      await expect(scoped.checkout(t.id, code)).rejects.toMatchObject({
        code: 'PLAN_INVALID',
      });
    const saved = settings.CLICK_SECRET_KEY;
    delete settings.CLICK_SECRET_KEY;
    await expect(scoped.checkout(t.id, priv.code)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    settings.CLICK_SECRET_KEY = saved;
  });
});

describe('Click callbacks', () => {
  it('Prepare then Complete pays once and extends the open subscription', async () => {
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
    const tid = ++trans;
    const base = { merchant_trans_id: o.paymentId, amount: o.amount, tid };
    const prep = await prepare(base);
    expect(prep).toMatchObject({ error: 0, error_note: 'Success' });
    expect(prep.merchant_prepare_id).toEqual(expect.any(Number));
    // Repeated Prepare answers the same id.
    expect((await prepare(base)).merchant_prepare_id).toBe(
      prep.merchant_prepare_id,
    );
    const done = await complete({
      ...base,
      prepare: String(prep.merchant_prepare_id),
    });
    expect(done).toMatchObject({ error: 0, click_trans_id: tid });
    expect(done.merchant_confirm_id).toEqual(expect.any(Number));
    const after = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.currentPeriodEnd.getTime()).toBe(
      end.getTime() + 30 * 86_400_000,
    );
    const payment = await db.subscriptionPayment.findUniqueOrThrow({
      where: { id: o.paymentId },
    });
    expect(payment).toMatchObject({ status: 'PAID', subscriptionId: sub.id });
    expect(payment.paidAt).not.toBeNull();
    expect(invalidate).toHaveBeenCalledWith(o.t.id);
    expect(
      await db.platformAuditEvent.count({
        where: { tenantId: o.t.id, action: 'payment.click_confirmed' },
      }),
    ).toBe(1);
    // A second Complete is -4 and never extends twice.
    const again = await complete({
      ...base,
      prepare: String(prep.merchant_prepare_id),
    });
    expect(again).toMatchObject({ error: -4, error_note: 'Already paid' });
    const final = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(final.currentPeriodEnd.getTime()).toBe(
      after.currentPeriodEnd.getTime(),
    );
    expect(
      await db.platformAuditEvent.count({
        where: { tenantId: o.t.id, action: 'payment.click_confirmed' },
      }),
    ).toBe(1);
  });

  it('a concurrent double Complete extends once', async () => {
    const o = await order();
    const sub = await db.tenantSubscription.create({
      data: {
        tenantId: o.t.id,
        planId: o.p.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      },
    });
    const tid = ++trans;
    const base = { merchant_trans_id: o.paymentId, amount: o.amount, tid };
    const prep = await prepare(base);
    const call = { ...base, prepare: String(prep.merchant_prepare_id) };
    const results = await Promise.all([complete(call), complete(call)]);
    expect(results.map((r) => r.error).sort()).toEqual([-4, 0]);
    const row = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(row.currentPeriodEnd.getTime()).toBeLessThan(
      Date.now() + 32 * 86_400_000,
    );
  });

  it('a payment during a trial starts the ACTIVE paid plan', async () => {
    const o = await order();
    const trial = await plan(0n);
    const sub = await db.tenantSubscription.create({
      data: {
        tenantId: o.t.id,
        planId: trial.id,
        status: 'TRIAL',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 3 * 86_400_000),
      },
    });
    const tid = ++trans;
    const base = { merchant_trans_id: o.paymentId, amount: o.amount, tid };
    const prep = await prepare(base);
    expect(
      (await complete({ ...base, prepare: String(prep.merchant_prepare_id) }))
        .error,
    ).toBe(0);
    const row = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(row).toMatchObject({ status: 'ACTIVE', planId: o.p.id });
    const open = await db.tenantSubscription.count({
      where: {
        tenantId: o.t.id,
        status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
      },
    });
    expect(open).toBe(1);
  });

  it('with no open subscription (expired) a payment starts a new ACTIVE one', async () => {
    const o = await order();
    await db.tenantSubscription.create({
      data: {
        tenantId: o.t.id,
        planId: o.p.id,
        status: 'EXPIRED',
        currentPeriodStart: new Date(Date.now() - 40 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() - 10 * 86_400_000),
      },
    });
    const tid = ++trans;
    const base = { merchant_trans_id: o.paymentId, amount: o.amount, tid };
    const prep = await prepare(base);
    await complete({ ...base, prepare: String(prep.merchant_prepare_id) });
    const rows = await db.tenantSubscription.findMany({
      where: { tenantId: o.t.id, status: 'ACTIVE' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.currentPeriodEnd.getTime()).toBeGreaterThan(
      Date.now() + 29 * 86_400_000,
    );
  });

  it('answers -1 for a wrong signature, -8 for a foreign service or missing fields', async () => {
    const o = await order();
    const base = { merchant_trans_id: o.paymentId, amount: o.amount };
    expect(await prepare({ ...base, secret: 'wrong' })).toMatchObject({
      error: -1,
      error_note: 'SIGN CHECK FAILED!',
    });
    expect(await prepare({ ...base, service: '1' })).toMatchObject({
      error: -8,
    });
    expect(await service.handle({}, false)).toMatchObject({ error: -8 });
    expect(await service.handle(null, true)).toMatchObject({ error: -8 });
  });

  it('answers -3 for the wrong action and -5 for unknown or non-uuid orders', async () => {
    const o = await order();
    expect(
      await prepare({
        merchant_trans_id: o.paymentId,
        amount: o.amount,
        action: '1',
      }),
    ).toMatchObject({ error: -3 });
    expect(
      await prepare({ merchant_trans_id: randomUUID(), amount: o.amount }),
    ).toMatchObject({ error: -5 });
    expect(
      await prepare({ merchant_trans_id: 'not-a-uuid', amount: o.amount }),
    ).toMatchObject({ error: -5 });
  });

  it('answers -2 for a wrong amount, in minor units', async () => {
    const o = await order();
    for (const amount of ['149999.99', '150000.01', '1', 'abc'])
      expect(
        await prepare({ merchant_trans_id: o.paymentId, amount }),
      ).toMatchObject({ error: -2 });
    expect(
      await prepare({ merchant_trans_id: o.paymentId, amount: '150000.0' }),
    ).toMatchObject({ error: 0 });
  });

  it('answers -6 for an unknown merchant_prepare_id', async () => {
    const o = await order();
    const tid = ++trans;
    const base = { merchant_trans_id: o.paymentId, amount: o.amount, tid };
    const prep = await prepare(base);
    expect(
      await complete({
        ...base,
        prepare: String(Number(prep.merchant_prepare_id) + 99999),
      }),
    ).toMatchObject({ error: -6 });
    expect(
      (
        await db.subscriptionPayment.findUniqueOrThrow({
          where: { id: o.paymentId },
        })
      ).status,
    ).toBe('PENDING');
  });

  it('a Click error below zero fails the payment and answers -9', async () => {
    const o = await order();
    const tid = ++trans;
    const base = { merchant_trans_id: o.paymentId, amount: o.amount, tid };
    const prep = await prepare(base);
    const call = { ...base, prepare: String(prep.merchant_prepare_id) };
    expect(await complete({ ...call, error: '-5017' })).toMatchObject({
      error: -9,
      error_note: 'Transaction cancelled',
    });
    expect(
      (
        await db.subscriptionPayment.findUniqueOrThrow({
          where: { id: o.paymentId },
        })
      ).status,
    ).toBe('FAILED');
    expect(
      (
        await db.clickTransaction.findFirstOrThrow({
          where: { paymentId: o.paymentId },
        })
      ).state,
    ).toBe('CANCELLED');
    // Later attempts on the failed order are -9 and never extend anything.
    expect(await prepare({ ...base, tid: ++trans })).toMatchObject({
      error: -9,
    });
    expect(await complete(call)).toMatchObject({ error: -9 });
    expect(
      await db.tenantSubscription.count({ where: { tenantId: o.t.id } }),
    ).toBe(0);
  });

  it('leaves another tenant untouched and never logs the secret', async () => {
    const o = await order();
    const other = await order();
    const tid = ++trans;
    const base = { merchant_trans_id: o.paymentId, amount: o.amount, tid };
    const prep = await prepare(base);
    await complete({ ...base, prepare: String(prep.merchant_prepare_id) });
    expect(
      (
        await db.subscriptionPayment.findUniqueOrThrow({
          where: { id: other.paymentId },
        })
      ).status,
    ).toBe('PENDING');
    expect(
      await db.tenantSubscription.count({ where: { tenantId: other.t.id } }),
    ).toBe(0);
    // A payment of another tenant cannot be confirmed through this order's prepare id.
    const stray = await complete({
      merchant_trans_id: other.paymentId,
      amount: other.amount,
      tid,
      prepare: String(prep.merchant_prepare_id),
    });
    expect(stray).toMatchObject({ error: -6 });
    const text = JSON.stringify(logs) + JSON.stringify(prep) + o.url;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(md5('x'));
  });
});
