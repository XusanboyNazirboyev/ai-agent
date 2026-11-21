import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceRequests } from '../observability/trace-requests.js';
import {
  appModuleEnvironment,
  ownerClient,
} from '../persistence/testing/test-clients.js';
import { configurePaymeProtocol } from './payme-http.js';

/** ADR 084 over HTTP: JSON-RPC and Basic Auth, with no operator session. */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Payme HTTP tests require agentcore_test');
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
const LOGIN = 'Paycom-http';
const KEY = `key-${randomUUID()}`;
process.env.PAYME_MERCHANT_ID = '507f1f77bcf86cd799439011';
process.env.PAYME_LOGIN = LOGIN;
process.env.PAYME_KEY = KEY;
const AUTH = `Basic ${Buffer.from(`${LOGIN}:${KEY}`).toString('base64')}`;

const db = ownerClient();
let app: NestExpressApplication;
let base = '';
const tenantIds: string[] = [];
const planCodes: string[] = [];

beforeAll(async () => {
  const { AppModule } = await import('../app.module.js');
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    abortOnError: false,
    rawBody: true,
  });
  app.use(traceRequests);
  configurePaymeProtocol(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.subscriptionPlan.deleteMany({ where: { code: { in: planCodes } } });
  await db.$disconnect();
});

async function post(
  method: string,
  params: Record<string, unknown>,
  authorization = AUTH,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/v1/payments/payme`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method, params }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('Payme over HTTP', () => {
  it('requires Basic Auth and completes the documented JSON-RPC flow', async () => {
    const plan = await db.subscriptionPlan.create({
      data: {
        code: `payme-http-${randomUUID().slice(0, 8)}`,
        name: 'Payme HTTP plan',
        priceMinor: 5_000_000n,
        periodDays: 30,
        isPublic: true,
      },
    });
    planCodes.push(plan.code);
    const tenant = await db.tenant.create({
      data: {
        slug: `payme-http-${randomUUID()}`,
        name: 'Payme HTTP',
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
        provider: 'PAYME',
        providerRef: `payme:${randomUUID()}`,
        amountMinor: 5_000_000n,
        status: 'PENDING',
        safeSummary: { planId: plan.id, planCode: plan.code, periodDays: 30 },
      },
    });
    const id = randomBytes(12).toString('hex');
    const create = {
      id,
      time: Date.now(),
      amount: 5_000_000,
      account: { order_id: payment.id },
    };
    const denied = await post('CheckPerformTransaction', create, '');
    expect(denied).toMatchObject({
      status: 200,
      body: { error: { code: -32504 } },
    });
    const checked = await post('CheckPerformTransaction', create);
    expect(checked).toMatchObject({
      status: 200,
      body: { result: { allow: true } },
    });
    expect(await post('CreateTransaction', create)).toMatchObject({
      status: 200,
      body: { result: { state: 1, transaction: payment.id } },
    });
    expect(await post('PerformTransaction', { id })).toMatchObject({
      status: 200,
      body: { result: { state: 2, transaction: payment.id } },
    });
    expect(JSON.stringify([denied, checked])).not.toContain(KEY);
  });

  it('keeps checkout session-protected', async () => {
    const response = await fetch(`${base}/api/v1/billing/payme/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planCode: 'x', locale: 'en' }),
    });
    expect(response.status).toBe(401);
  });

  it('answers malformed JSON with the Payme parse error and HTTP 200', async () => {
    const response = await fetch(`${base}/api/v1/payments/payme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTH },
      body: '{',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700 },
    });
  });

  it('answers a non-POST call with the protocol error and HTTP 200', async () => {
    const response = await fetch(`${base}/api/v1/payments/payme`, {
      headers: { authorization: AUTH },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32300 },
    });
  });
});
