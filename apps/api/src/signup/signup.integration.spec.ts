import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceRequests } from '../observability/trace-requests.js';
import {
  appModuleEnvironment,
  ownerClient,
} from '../persistence/testing/test-clients.js';
import { platformWebhookPathSecret } from './signup-rules.js';

/** ADR 080 over HTTP on the real AppModule and database; Telegram is a local fake. */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Signup tests require agentcore_test');
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
process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '1000';
process.env.WEB_ORIGINS = 'http://localhost:3000';
delete process.env.WEB_PROXY_SECRET;
const HEADER_SECRET = `hdr${randomBytes(12).toString('hex')}`;
process.env.PLATFORM_TELEGRAM_BOT_TOKEN = `fake:${randomBytes(8).toString('hex')}`;
process.env.PLATFORM_TELEGRAM_BOT_USERNAME = 'tezda_test_bot';
process.env.PLATFORM_TELEGRAM_WEBHOOK_SECRET = HEADER_SECRET;

const db = ownerClient();
const suffix = randomUUID().slice(0, 8);
const PLAN = `signup-${suffix}`;
const PASSWORD = 'a long enough password';
let app: INestApplication;
let base = '';
let fake: Server;
const sent: { text: string; markup?: { keyboard?: unknown } }[] = [];
let updateId = 1000 * (Date.now() % 100000);
const tenants: string[] = [];

beforeAll(async () => {
  fake = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk: Buffer) => (data += chunk.toString()));
    request.on('end', () => {
      const body = JSON.parse(data || '{}') as {
        text: string;
        reply_markup?: { keyboard?: unknown };
      };
      sent.push({ text: body.text, markup: body.reply_markup });
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true,"result":{"message_id":1}}');
    });
  });
  await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
  const address = fake.address() as { port: number };
  process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  await db.subscriptionPlan.create({
    data: {
      code: PLAN,
      name: 'Signup test',
      priceMinor: 100n,
      periodDays: 30,
      isPublic: true,
    },
  });
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
  fake?.close();
  const ids = tenants;
  await db.trialClaim.deleteMany({ where: { tenantId: { in: ids } } });
  await db.pendingSignup.deleteMany({ where: { plan: { code: PLAN } } });
  await db.tenant.deleteMany({ where: { id: { in: ids } } });
  await db.subscriptionPlan.deleteMany({ where: { code: PLAN } });
  await db.$disconnect();
});

async function http(
  method: string,
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
  cookies: string[];
}> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    cookies: response.headers.getSetCookie(),
  };
}

interface Started {
  id: string;
  token: string;
  cookie: string;
  email: string;
}

async function start(
  email = `own-${randomUUID().slice(0, 8)}@example.test`,
): Promise<Started> {
  const result = await http('POST', '/api/v1/public/signups', {
    body: {
      businessName: `Shop ${suffix}`,
      name: 'Ali',
      email,
      password: PASSWORD,
      planCode: PLAN,
    },
  });
  expect(result.status).toBe(201);
  const url = String(result.body.telegramUrl);
  expect(url.startsWith('https://t.me/tezda_test_bot?start=')).toBe(true);
  const cookie = (result.cookies[0] ?? '').split(';')[0] ?? '';
  return {
    id: String(result.body.id),
    token: url.split('start=')[1] ?? '',
    cookie,
    email,
  };
}

function webhook(
  message: Record<string, unknown>,
  options: { secret?: string; path?: string } = {},
): Promise<{ status: number }> {
  updateId += 1;
  return http(
    'POST',
    `/webhooks/platform-telegram/${options.path ?? platformWebhookPathSecret(HEADER_SECRET)}`,
    {
      body: { update_id: updateId, message },
      headers: {
        'x-telegram-bot-api-secret-token': options.secret ?? HEADER_SECRET,
      },
    },
  );
}

const from = (id: number): { id: number; language_code: string } => ({
  id,
  language_code: 'ru',
});
let nextUser = 700_000_000 + (Date.now() % 1_000_000);
const newUser = (): number => (nextUser += 1);
const newPhone = (): string =>
  `+99890${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

function sendStart(user: number, token: string): Promise<{ status: number }> {
  return webhook({
    message_id: 1,
    from: from(user),
    chat: { id: user, type: 'private' },
    text: `/start ${token}`,
  });
}
function sendContact(
  user: number,
  phone: string,
  owner = user,
): Promise<{ status: number }> {
  return webhook({
    message_id: 2,
    from: from(user),
    chat: { id: user, type: 'private' },
    contact: { phone_number: phone, user_id: owner },
  });
}

describe('self-serve signup (ADR 080)', () => {
  it('creates tenant, owner and 3-day trial once, then signs in once', async () => {
    const s = await start();
    const user = newUser();
    const phone = newPhone();
    sent.length = 0;
    expect((await sendStart(user, s.token)).status).toBe(200);
    expect(sent[0]?.markup?.keyboard).toBeTruthy();
    expect(sent[0]?.text).toContain('номер');
    expect((await http('GET', `/api/v1/public/signups/${s.id}`)).body).toEqual({
      status: 'PENDING',
    });
    expect((await sendContact(user, phone)).status).toBe(200);
    const row = await db.pendingSignup.findUniqueOrThrow({
      where: { id: s.id },
    });
    expect(row.status).toBe('CONFIRMED');
    tenants.push(row.createdTenantId as string);
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: row.createdTenantId as string },
    });
    expect(tenant.config).toMatchObject({ billing: { required: true } });
    const owners = await db.operator.findMany({
      where: { tenantId: tenant.id },
    });
    expect(owners.map((o) => o.role)).toEqual(['OWNER']);
    const subs = await db.tenantSubscription.findMany({
      where: { tenantId: tenant.id },
    });
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe('TRIAL');
    const days =
      ((subs[0]?.currentPeriodEnd.getTime() ?? 0) -
        (subs[0]?.currentPeriodStart.getTime() ?? 0)) /
      86_400_000;
    expect(Math.round(days)).toBe(3);
    expect(
      await db.platformAuditEvent.count({
        where: { tenantId: tenant.id, action: 'tenant.self_signup' },
      }),
    ).toBe(1);
    // A repeated delivery of the same contact changes nothing.
    await sendContact(user, phone);
    expect(await db.tenant.count({ where: { id: tenant.id } })).toBe(1);
    // Status: another browser is not signed in; the bound browser is, once.
    const other = await http('GET', `/api/v1/public/signups/${s.id}`);
    expect(other.body).toEqual({ status: 'CONFIRMED', signedIn: false });
    expect(other.cookies).toEqual([]);
    const first = await http('GET', `/api/v1/public/signups/${s.id}`, {
      cookie: s.cookie,
    });
    expect(first.body).toMatchObject({ status: 'CONFIRMED', signedIn: true });
    expect(first.cookies.some((c) => c.startsWith('ac_session='))).toBe(true);
    const second = await http('GET', `/api/v1/public/signups/${s.id}`, {
      cookie: s.cookie,
    });
    expect(second.body).toEqual({ status: 'CONFIRMED', signedIn: false });
    const login = await http('POST', '/api/v1/auth/login', {
      body: { email: s.email, password: PASSWORD },
    });
    expect(login.status).toBe(200);
  });

  it('refuses a foreign contact and leaves the signup pending', async () => {
    const s = await start();
    const user = newUser();
    await sendStart(user, s.token);
    sent.length = 0;
    await sendContact(user, newPhone(), user + 1);
    expect(sent[0]?.markup?.keyboard).toBeTruthy();
    expect(
      (await db.pendingSignup.findUniqueOrThrow({ where: { id: s.id } }))
        .status,
    ).toBe('PENDING');
  });

  it('refuses an expired token', async () => {
    const s = await start();
    await db.pendingSignup.update({
      where: { id: s.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    sent.length = 0;
    await sendStart(newUser(), s.token);
    expect(sent[0]?.text).toContain('устарела');
    expect((await http('GET', `/api/v1/public/signups/${s.id}`)).body).toEqual({
      status: 'EXPIRED',
    });
  });

  it('allows one trial per Telegram user and per phone', async () => {
    const a = await start();
    const user = newUser();
    const phone = newPhone();
    await sendStart(user, a.token);
    await sendContact(user, phone);
    const created = (
      await db.pendingSignup.findUniqueOrThrow({ where: { id: a.id } })
    ).createdTenantId as string;
    tenants.push(created);
    // Same Telegram user, new signup.
    const b = await start();
    await sendStart(user, b.token);
    expect(
      (await http('GET', `/api/v1/public/signups/${b.id}`)).body,
    ).toMatchObject({ status: 'REFUSED', reason: 'TRIAL_USED' });
    // Different Telegram user, same phone.
    const c = await start();
    const other = newUser();
    await sendStart(other, c.token);
    await sendContact(other, phone);
    expect(
      (await http('GET', `/api/v1/public/signups/${c.id}`)).body,
    ).toMatchObject({ status: 'REFUSED', reason: 'TRIAL_USED' });
    expect(
      await db.tenant.count({
        where: { slug: { startsWith: 'shop-' }, id: { notIn: tenants } },
      }),
    ).toBe(0);
  });

  it('answers EMAIL_TAKEN, bad plan and bad input', async () => {
    const s = await start();
    const user = newUser();
    await sendStart(user, s.token);
    await sendContact(user, newPhone());
    tenants.push(
      (await db.pendingSignup.findUniqueOrThrow({ where: { id: s.id } }))
        .createdTenantId as string,
    );
    const taken = await http('POST', '/api/v1/public/signups', {
      body: {
        businessName: 'Again',
        name: 'Ali',
        email: s.email.toUpperCase(),
        password: PASSWORD,
        planCode: PLAN,
      },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('EMAIL_TAKEN');
    const plan = await http('POST', '/api/v1/public/signups', {
      body: {
        businessName: 'Again',
        name: 'Ali',
        email: 'x@example.test',
        password: PASSWORD,
        planCode: 'nope',
      },
    });
    expect(plan.status).toBe(400);
    const weak = await http('POST', '/api/v1/public/signups', {
      body: {
        businessName: 'Again',
        name: 'Ali',
        email: 'x@example.test',
        password: 'short',
        planCode: PLAN,
      },
    });
    expect(weak.status).toBe(400);
    const origin = await http('POST', '/api/v1/public/signups', {
      body: {
        businessName: 'Again',
        name: 'Ali',
        email: 'x@example.test',
        password: PASSWORD,
        planCode: PLAN,
      },
      headers: { origin: 'https://evil.example' },
    });
    expect(origin.status).toBe(403);
  });

  it('checks the webhook secrets', async () => {
    const message = {
      message_id: 1,
      from: from(newUser()),
      chat: { id: 1, type: 'private' },
      text: '/start',
    };
    expect(
      (await webhook(message, { secret: 'wrong-wrong-wrong-wrong' })).status,
    ).toBe(403);
    expect((await webhook(message, { path: 'a'.repeat(40) })).status).toBe(403);
    expect((await webhook(message)).status).toBe(200);
  });

  it('never creates channel accounts, conversations or leads', async () => {
    const before = await Promise.all([
      db.channelAccount.count(),
      db.conversation.count(),
      db.lead.count(),
    ]);
    await webhook({
      message_id: 1,
      from: from(newUser()),
      chat: { id: 5, type: 'private' },
      text: 'hello',
    });
    const after = await Promise.all([
      db.channelAccount.count(),
      db.conversation.count(),
      db.lead.count(),
    ]);
    expect(after).toEqual(before);
  });
});
