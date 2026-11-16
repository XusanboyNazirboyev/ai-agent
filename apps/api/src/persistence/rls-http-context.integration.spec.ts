import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { signMetaBody } from '../channels/meta/meta-webhook-auth.js';
import { traceRequests } from '../observability/trace-requests.js';
import { createPostgresAdapter } from './postgres-adapter.js';
import { hashPassword } from '../webinbox/password.js';

/**
 * RLS plan S5 acceptance: the real AppModule over HTTP (with the tenant slot
 * main.ts opens for every request) in RLS_CONTEXT_MODE=warn and a separate
 * privileged pool (POSTGRES_ADMIN_USER). Sign-in, the session check, tenant
 * pages, an invite and its acceptance, and a Telegram and an Instagram
 * webhook may not run a single statement on the main connection while their
 * request is still waiting for its tenant: what runs before the tenant is
 * known goes through the privileged connection, everything after it runs
 * under the tenant. The app cannot boot in strict mode yet: startup checks
 * and background jobs have no tenant (S6/S7), so warn mode reports and each
 * in-request report fails the test.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('RLS HTTP context test requires agentcore_test');
}
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

const TELEGRAM_SECRET = 'rls-strict-webhook-secret';
const META_SECRET = 'rls-strict-meta-secret';
const PASSWORD = 'correct horse battery';

const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});

interface Fixture {
  tenantId: string;
  telegramAccountId: string;
  igUserId: string;
  email: string;
}

async function seed(): Promise<Fixture> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `rls-${suffix}`,
      name: 'RLS strict fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  // agentMode OFF (the default): nothing is ever sent to a customer.
  const telegram = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `rls-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const igUserId = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'instagram',
      externalAccountId: igUserId,
      status: 'ACTIVE',
    },
  });
  const operator = await db.operator.create({
    data: { tenantId: tenant.id, displayName: 'Owner', role: 'OWNER' },
  });
  const email = `rls-${suffix}@example.test`;
  await db.operatorCredential.create({
    data: {
      tenantId: tenant.id,
      operatorId: operator.id,
      email,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  return {
    tenantId: tenant.id,
    telegramAccountId: telegram.id,
    igUserId,
    email,
  };
}

/** Warnings the app logs; the in-request tenant misses are the S5 signal. */
const warnings: string[] = [];
const capture: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
  warn: (message: unknown) => {
    if (typeof message === 'string') warnings.push(message);
  },
};
const inRequestMisses = (): string[] =>
  warnings.filter(
    (line) =>
      line.includes('db.tenant_context_missing') &&
      line.includes('"inRequest":true'),
  );

describe('RLS tenant context over HTTP (plan S5)', () => {
  let app: INestApplication;
  let base: string;
  let f: Fixture;

  beforeAll(async () => {
    f = await seed();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      RLS_CONTEXT_MODE: 'warn',
      // Its own pool as the same test role: unwrapped, so no tenant needed.
      POSTGRES_ADMIN_USER: process.env.TEST_POSTGRES_USER,
      TELEGRAM_CHANNEL_ACCOUNT_ID: f.telegramAccountId,
      TELEGRAM_WEBHOOK_SECRET: TELEGRAM_SECRET,
      // Nothing may reach Telegram from this test: a placeholder token
      // (process.env wins over the .env file) and an address nothing serves.
      TELEGRAM_BOT_TOKEN: '000000:placeholder-not-a-token',
      TELEGRAM_API_BASE_URL: 'http://127.0.0.1:9',
      INSTAGRAM_APP_SECRET: META_SECRET,
      SESSION_COOKIE_SECURE: 'false',
    });
    // Unset stays unset (assigning undefined would store "undefined").
    if (process.env.TEST_POSTGRES_PASSWORD !== undefined)
      process.env.POSTGRES_ADMIN_PASSWORD = process.env.TEST_POSTGRES_PASSWORD;
    const { AppModule } = await import('../app.module.js');
    app = await NestFactory.create(AppModule, {
      logger: capture,
      abortOnError: false,
      rawBody: true,
    });
    // As main.ts: every request gets a tenant slot the session fills.
    app.use(traceRequests);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterEach(() => {
    const misses = inRequestMisses();
    warnings.length = 0;
    expect(misses).toEqual([]);
  });

  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });

  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: f.email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { csrfToken: string };
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    return { cookie, csrf: body.csrfToken };
  }

  it('signs in, checks the session and serves tenant pages', async () => {
    const { cookie } = await signIn();
    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/team',
      '/api/v1/inbox/conversations',
    ]) {
      const response = await fetch(`${base}${path}`, { headers: { cookie } });
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
  });

  it('invites a teammate and lets them accept with a new password', async () => {
    const { cookie, csrf } = await signIn();
    const created = await fetch(`${base}/api/v1/team/invites`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({
        email: `invited-${randomUUID()}@example.test`,
        role: 'OPERATOR',
      }),
    });
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };
    const preview = await fetch(`${base}/api/v1/auth/invites/${token}`);
    expect(preview.status).toBe(200);
    const accepted = await fetch(
      `${base}/api/v1/auth/invites/${token}/accept`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Invited', password: PASSWORD }),
      },
    );
    expect(accepted.status).toBe(200);
  });

  it('accepts a Telegram update routed by its account', async () => {
    const response = await fetch(
      `${base}/webhooks/telegram/${f.telegramAccountId}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': TELEGRAM_SECRET,
        },
        body: JSON.stringify({
          update_id: Math.floor(Math.random() * 1e9),
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 4242, type: 'private' },
            from: { id: 4242, first_name: 'Customer' },
            text: 'Salom',
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accepted: true });
    // An account nobody owns answers like an unconfigured one.
    const unknown = await fetch(`${base}/webhooks/telegram/${randomUUID()}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TELEGRAM_SECRET,
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(unknown.status).toBe(503);
  });

  it('accepts an Instagram message routed by its account', async () => {
    const raw = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: f.igUserId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: '1234567890' },
              recipient: { id: f.igUserId },
              timestamp: Date.now(),
              message: { mid: `mid.rls.${randomUUID()}`, text: 'Salom' },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${base}/webhooks/instagram`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signMetaBody(raw, META_SECRET),
      },
      body: raw,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accepted: 1 });
  });
});
