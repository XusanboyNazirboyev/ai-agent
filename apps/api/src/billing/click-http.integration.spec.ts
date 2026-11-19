import { config as loadEnv } from 'dotenv';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceRequests } from '../observability/trace-requests.js';
import {
  appModuleEnvironment,
  ownerClient,
} from '../persistence/testing/test-clients.js';

/** ADR 082 over HTTP: form-encoded callbacks, no session; checkout needs one. */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Click HTTP tests require agentcore_test');
for (const key of [
  'HOST',
  'PORT',
  'DATABASE',
  'USER',
  'PASSWORD',
  'SSL_MODE',
]) {
  const value = process.env[`TEST_POSTGRES_${key}`];
  if (value !== undefined) process.env[`POSTGRES_${key}`] = value;
}
Object.assign(process.env, appModuleEnvironment());
process.env.NODE_ENV = 'test';
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.WEB_ORIGINS = 'http://localhost:3000';
delete process.env.WEB_PROXY_SECRET;
const SECRET = `sk-${randomUUID()}`;
process.env.CLICK_SERVICE_ID = '4243';
process.env.CLICK_MERCHANT_ID = '778';
process.env.CLICK_SECRET_KEY = SECRET;

const db = ownerClient();
let app: INestApplication;
let base = '';
const tenantIds: string[] = [];
const planCodes: string[] = [];

beforeAll(async () => {
  const { AppModule } = await import('../app.module.js');
  app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  app.use(traceRequests);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.subscriptionPlan.deleteMany({ where: { code: { in: planCodes } } });
  await db.$disconnect();
});

const md5 = (text: string): string =>
  createHash('md5').update(text).digest('hex');

async function post(
  path: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; type: string }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('Click over HTTP', () => {
  it('reads form-encoded Prepare/Complete and always answers HTTP 200 JSON', async () => {
    const plan = await db.subscriptionPlan.create({
      data: {
        code: `click-http-${randomUUID().slice(0, 8)}`,
        name: 'HTTP plan',
        priceMinor: 5000000n,
        periodDays: 30,
        isPublic: true,
      },
    });
    planCodes.push(plan.code);
    const tenant = await db.tenant.create({
      data: {
        slug: `click-http-${randomUUID()}`,
        name: 'Click HTTP',
        defaultLocale: 'en',
        supportedLocales: ['en'],
        timezone: 'UTC',
        packKey: 'education',
        packVersion: '1',
      },
    });
    tenantIds.push(tenant.id);
    const payment = await db.subscriptionPayment.create({
      data: {
        tenantId: tenant.id,
        provider: 'CLICK',
        providerRef: `click:${randomUUID()}`,
        amountMinor: 5000000n,
        status: 'PENDING',
        safeSummary: { planId: plan.id, planCode: plan.code, periodDays: 30 },
      },
    });
    const tid = String(8_000_000 + (Date.now() % 1_000_000));
    const time = '2026-11-19 11:00:00';
    const fields = {
      click_trans_id: tid,
      service_id: '4243',
      click_paydoc_id: '1',
      merchant_trans_id: payment.id,
      amount: '50000.00',
      action: '0',
      error: '0',
      sign_time: time,
    };
    const bad = await post('/api/v1/payments/click/prepare', {
      ...fields,
      sign_string: 'deadbeef',
    });
    expect(bad.status).toBe(200);
    expect(bad.type).toContain('application/json');
    expect(bad.body).toMatchObject({ error: -1 });
    const ok = await post('/api/v1/payments/click/prepare', {
      ...fields,
      sign_string: md5(`${tid}4243${SECRET}${payment.id}50000.00${'0'}${time}`),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ error: 0, merchant_trans_id: payment.id });
    const prepareId = String(ok.body.merchant_prepare_id);
    const done = await post('/api/v1/payments/click/complete', {
      ...fields,
      action: '1',
      merchant_prepare_id: prepareId,
      sign_string: md5(
        `${tid}4243${SECRET}${payment.id}${prepareId}50000.00${'1'}${time}`,
      ),
    });
    expect(done.body).toMatchObject({ error: 0 });
    expect(JSON.stringify([bad, ok, done])).not.toContain(SECRET);
    const row = await db.subscriptionPayment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(row.status).toBe('PAID');
  });

  it('the checkout needs a session; the callbacks need none', async () => {
    const response = await fetch(`${base}/api/v1/billing/click/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planCode: 'x' }),
    });
    expect(response.status).toBe(401);
    const empty = await post('/api/v1/payments/click/prepare', {});
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ error: -8 });
  });
});
