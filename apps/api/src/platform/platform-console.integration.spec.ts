import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import { hashPassword } from '../webinbox/password.js';

/**
 * ADR 047 over HTTP on the real AppModule and database: platform sign-in and
 * guard, tenant creation with an OWNER invite, invite acceptance, team rules,
 * suspension and expiry as seen by the tenant's login and /me.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Platform console tests require agentcore_test');
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
process.env.NODE_ENV = 'test';
process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '1000';
process.env.WEB_ORIGINS = 'http://localhost:3000';
delete process.env.WEB_PROXY_SECRET;

const ORIGIN = 'http://localhost:3000';
const FAST = { N: 1024, r: 8, p: 1 };
const PACK = [...DOMAIN_PACKS.keys()][0] as string;
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
let app: INestApplication;
let base = '';
const suffix = randomUUID().slice(0, 8);
const OWNER_EMAIL = `p-owner-${suffix}@example.test`;
const SUPPORT_EMAIL = `p-support-${suffix}@example.test`;
const ADMIN_PASSWORD = 'platform admin password';

beforeAll(async () => {
  for (const [email, role] of [
    [OWNER_EMAIL, 'PLATFORM_OWNER'],
    [SUPPORT_EMAIL, 'PLATFORM_SUPPORT'],
  ] as const)
    await db.platformAdmin.create({
      data: {
        email,
        displayName: role,
        role,
        passwordHash: await hashPassword(ADMIN_PASSWORD, FAST),
      },
    });
  const { AppModule } = await import('../app.module.js');
  app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});

interface Session {
  cookie: string;
  csrf: string;
}

interface Result {
  status: number;
  body: Record<string, unknown>;
  cookies: string[];
}

async function call(
  method: string,
  path: string,
  options: {
    session?: Session;
    body?: unknown;
    csrf?: string | null;
    origin?: string;
  } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.session) headers.cookie = options.session.cookie;
  const csrf =
    options.csrf === undefined ? options.session?.csrf : options.csrf;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (options.origin) headers.origin = options.origin;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    cookies: response.headers.getSetCookie(),
  };
}

function sessionFrom(result: Result, name: string): Session {
  const cookie = result.cookies
    .map((value) => value.split(';')[0] ?? '')
    .find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`no ${name} cookie`);
  return { cookie, csrf: String(result.body.csrfToken) };
}

async function platformLogin(email: string): Promise<Session> {
  const result = await call('POST', '/api/v1/platform/auth/login', {
    body: { email, password: ADMIN_PASSWORD },
  });
  expect(result.status).toBe(200);
  return sessionFrom(result, 'ac_platform');
}

async function tenantLogin(email: string, password: string): Promise<Result> {
  return call('POST', '/api/v1/auth/login', { body: { email, password } });
}

async function accept(
  token: string,
  displayName: string,
  password: string,
): Promise<Session> {
  const result = await call('POST', `/api/v1/auth/invites/${token}/accept`, {
    body: { displayName, password },
  });
  expect(result.status).toBe(200);
  return sessionFrom(result, 'ac_session');
}

describe('platform sign-in and guard', () => {
  it('signs in with its own cookies and refuses wrong passwords', async () => {
    const wrong = await call('POST', '/api/v1/platform/auth/login', {
      body: { email: OWNER_EMAIL, password: 'nope' },
    });
    expect(wrong.status).toBe(401);
    const login = await call('POST', '/api/v1/platform/auth/login', {
      body: { email: OWNER_EMAIL.toUpperCase(), password: ADMIN_PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(
      login.cookies.some(
        (c) => c.startsWith('ac_platform=') && c.includes('HttpOnly'),
      ),
    ).toBe(true);
    expect(login.cookies.some((c) => c.startsWith('ac_platform_csrf='))).toBe(
      true,
    );
    expect(login.cookies.some((c) => c.startsWith('ac_session='))).toBe(false);
    const session = sessionFrom(login, 'ac_platform');
    const me = await call('GET', '/api/v1/platform/auth/me', { session });
    expect(me.status).toBe(200);
    expect(me.body.admin).toMatchObject({
      email: OWNER_EMAIL,
      role: 'PLATFORM_OWNER',
    });
  });

  it('never accepts a cookie of the other principal type', async () => {
    const platform = await platformLogin(OWNER_EMAIL);
    const token = platform.cookie.split('=')[1] ?? '';
    // A platform token under the tenant cookie name, and vice versa.
    expect(
      (
        await call('GET', '/api/v1/auth/me', {
          session: { cookie: `ac_session=${token}`, csrf: '' },
        })
      ).status,
    ).toBe(401);
    expect(
      (await call('GET', '/api/v1/auth/me', { session: platform })).status,
    ).toBe(401);
    expect(
      (
        await call('GET', '/api/v1/platform/tenants', {
          session: { cookie: `ac_session=${token}`, csrf: '' },
        })
      ).status,
    ).toBe(401);
    expect((await call('GET', '/api/v1/platform/tenants')).status).toBe(401);
  });

  it('requires the CSRF header and an allowed Origin on writes', async () => {
    const session = await platformLogin(OWNER_EMAIL);
    const body = {
      code: `csrf-${suffix}`,
      name: 'x',
      priceMinor: 1,
      periodDays: 30,
    };
    const noCsrf = await call('POST', '/api/v1/platform/plans', {
      session,
      body,
      csrf: null,
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF');
    const badOrigin = await call('POST', '/api/v1/platform/plans', {
      session,
      body,
      origin: 'https://evil.example',
    });
    expect(badOrigin.body.code).toBe('BAD_ORIGIN');
    expect(
      await db.subscriptionPlan.count({ where: { code: `csrf-${suffix}` } }),
    ).toBe(0);
  });

  it('PLATFORM_SUPPORT reads but never writes', async () => {
    const support = await platformLogin(SUPPORT_EMAIL);
    expect(
      (await call('GET', '/api/v1/platform/tenants', { session: support }))
        .status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/v1/platform/plans', { session: support }))
        .status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/v1/platform/audit', { session: support }))
        .status,
    ).toBe(200);
    const write = await call('POST', '/api/v1/platform/plans', {
      session: support,
      origin: ORIGIN,
      body: {
        code: `support-${suffix}`,
        name: 'x',
        priceMinor: 1,
        periodDays: 30,
      },
    });
    expect(write.status).toBe(403);
    expect(
      (await call('GET', '/api/v1/platform/admins', { session: support }))
        .status,
    ).toBe(403);
    expect(
      (await call('POST', '/api/v1/platform/auth/logout', { session: support }))
        .status,
    ).toBe(204);
    expect(
      (await call('GET', '/api/v1/platform/tenants', { session: support }))
        .status,
    ).toBe(401);
  });
});

describe('tenant lifecycle from the console', () => {
  const slug = `console-${suffix}`;
  const ownerEmail = `t-owner-${suffix}@example.test`;
  const ownerPassword = 'tenant owner password';
  let platform: Session;
  let tenantId = '';
  let planId = '';
  let owner: Session;

  it('creates a plan, a tenant with a trial and an OWNER invite; the invite signs in', async () => {
    platform = await platformLogin(OWNER_EMAIL);
    const plan = await call('POST', '/api/v1/platform/plans', {
      session: platform,
      body: {
        code: `basic-${suffix}`,
        name: 'Basic',
        priceMinor: 50_000_000,
        periodDays: 30,
        limits: { maxOperators: 2 },
      },
    });
    expect(plan.status).toBe(201);
    planId = String(plan.body.id);
    const options = await call('GET', '/api/v1/platform/tenants/options', {
      session: platform,
    });
    expect(options.status).toBe(200);
    expect(options.body.packs).toContain(PACK);
    expect(options.body.locales).toEqual(
      expect.arrayContaining(['uz-Latn', 'ru', 'en']),
    );

    const created = await call('POST', '/api/v1/platform/tenants', {
      session: platform,
      body: {
        slug,
        name: 'Console tenant',
        pack: PACK,
        defaultLocale: 'ru',
        timezone: 'Asia/Tashkent',
        ownerEmail,
        planId,
        trialDays: 14,
      },
    });
    expect(created.status).toBe(201);
    tenantId = String((created.body.tenant as { id: string }).id);
    const invite = created.body.invite as {
      token: string;
      path: string;
      role: string;
    };
    expect(invite.role).toBe('OWNER');
    expect(invite.path).toBe(`/invite/${invite.token}`);
    const stored = await db.operatorInvite.findFirstOrThrow({
      where: { tenantId },
    });
    expect(stored.tokenHash).not.toBe(invite.token);
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    expect(tenant.config).toEqual({ billing: { required: true } });
    expect(
      (
        await call('POST', '/api/v1/platform/tenants', {
          session: platform,
          body: {
            slug,
            name: 'Dup',
            pack: PACK,
            defaultLocale: 'ru',
            timezone: 'UTC',
            ownerEmail: `x-${ownerEmail}`,
          },
        })
      ).status,
    ).toBe(409);

    const preview = await call('GET', `/api/v1/auth/invites/${invite.token}`);
    expect(preview.body).toMatchObject({
      email: ownerEmail,
      role: 'OWNER',
      tenantName: 'Console tenant',
    });
    owner = await accept(invite.token, 'New Owner', ownerPassword);
    const me = await call('GET', '/api/v1/auth/me', { session: owner });
    expect(me.body.operator).toMatchObject({
      displayName: 'New Owner',
      role: 'OWNER',
    });
    expect((me.body.access as { state: string }).state).toBe('ok');
    // The token is single-use.
    const again = await call(
      'POST',
      `/api/v1/auth/invites/${invite.token}/accept`,
      {
        body: { displayName: 'Again', password: ownerPassword },
      },
    );
    expect(again.status).toBe(404);
    expect((await tenantLogin(ownerEmail, ownerPassword)).status).toBe(200);

    const list = await call('GET', '/api/v1/platform/tenants?q=' + slug, {
      session: platform,
    });
    const row = (
      list.body.tenants as {
        id: string;
        subscription: { status: string };
        usage: object;
      }[]
    ).find((t) => t.id === tenantId);
    expect(row?.subscription.status).toBe('TRIAL');
    expect(row?.usage).toEqual({
      conversations: 0,
      inboundMessages: 0,
      llmCostUsd: 0,
    });
    const audit = await call(
      'GET',
      `/api/v1/platform/audit?tenantId=${tenantId}`,
      { session: platform },
    );
    const actions = (audit.body.events as { action: string }[]).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['tenant.created', 'subscription.started']),
    );
  });

  it('applies the team rules and the seat limit', async () => {
    const invited = await call('POST', '/api/v1/team/invites', {
      session: owner,
      body: { email: `t-admin-${suffix}@example.test`, role: 'ADMIN' },
    });
    expect(invited.status).toBe(201);
    const admin = await accept(
      String(invited.body.token),
      'Team Admin',
      'team admin password',
    );
    const adminMe = await call('GET', '/api/v1/auth/me', { session: admin });
    const adminId = (adminMe.body.operator as { id: string }).id;
    const ownerId = (
      (await call('GET', '/api/v1/auth/me', { session: owner })).body
        .operator as { id: string }
    ).id;

    // Plan maxOperators = 2: OWNER + ADMIN fill it.
    const third = await call('POST', '/api/v1/team/invites', {
      session: owner,
      body: { email: `t-third-${suffix}@example.test`, role: 'OPERATOR' },
    });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('SEATS_EXHAUSTED');

    const adminInvitesOwner = await call('POST', '/api/v1/team/invites', {
      session: admin,
      body: { email: `t-own2-${suffix}@example.test`, role: 'OWNER' },
    });
    expect(adminInvitesOwner.body.code).toBe('OWNER_ONLY');
    const adminDeactivatesOwner = await call(
      'PATCH',
      `/api/v1/team/operators/${ownerId}`,
      {
        session: admin,
        body: { isActive: false },
      },
    );
    expect(adminDeactivatesOwner.body.code).toBe('OWNER_ONLY');
    const self = await call('PATCH', `/api/v1/team/operators/${ownerId}`, {
      session: owner,
      body: { role: 'ADMIN' },
    });
    expect(self.body.code).toBe('SELF_EDIT');

    const team = await call('GET', '/api/v1/team', { session: owner });
    expect(team.body.limits).toEqual({ maxOperators: 2, seatsUsed: 2 });

    const demoted = await call('PATCH', `/api/v1/team/operators/${adminId}`, {
      session: owner,
      body: { role: 'VIEWER' },
    });
    expect(demoted.status).toBe(200);
    expect((await call('GET', '/api/v1/team', { session: admin })).status).toBe(
      403,
    );
    const deactivated = await call(
      'PATCH',
      `/api/v1/team/operators/${adminId}`,
      {
        session: owner,
        body: { isActive: false },
      },
    );
    expect(deactivated.body).toMatchObject({ isActive: false, role: 'VIEWER' });
    expect(
      (await call('GET', '/api/v1/auth/me', { session: admin })).status,
    ).toBe(401);
    expect(
      await db.auditEvent.count({
        where: { tenantId, action: 'team.operator_updated' },
      }),
    ).toBe(2);
  });

  it('suspension signs the tenant out and blocks login; reactivation restores it', async () => {
    const noReason = await call(
      'PATCH',
      `/api/v1/platform/tenants/${tenantId}`,
      {
        session: platform,
        body: { status: 'SUSPENDED' },
      },
    );
    expect(noReason.status).toBe(400);
    const suspended = await call(
      'PATCH',
      `/api/v1/platform/tenants/${tenantId}`,
      {
        session: platform,
        body: { status: 'SUSPENDED', reason: 'unpaid invoice' },
      },
    );
    expect(suspended.body.status).toBe('SUSPENDED');
    expect(
      (await call('GET', '/api/v1/auth/me', { session: owner })).status,
    ).toBe(401);
    const blocked = await tenantLogin(ownerEmail, ownerPassword);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TENANT_SUSPENDED');
    // A wrong password still says only "invalid".
    expect((await tenantLogin(ownerEmail, 'wrong password!')).status).toBe(401);

    await call('PATCH', `/api/v1/platform/tenants/${tenantId}`, {
      session: platform,
      body: { status: 'ACTIVE', reason: 'paid' },
    });
    const back = await tenantLogin(ownerEmail, ownerPassword);
    expect(back.status).toBe(200);
    owner = sessionFrom(back, 'ac_session');
  });

  it('expiry keeps login, shows the state on /me; payments extend the period', async () => {
    const canceled = await call(
      'POST',
      `/api/v1/platform/tenants/${tenantId}/subscription/cancel`,
      {
        session: platform,
        body: { reason: 'test cancel' },
      },
    );
    expect(canceled.body.status).toBe('CANCELED');
    expect((await tenantLogin(ownerEmail, ownerPassword)).status).toBe(200);
    const me = await call('GET', '/api/v1/auth/me', { session: owner });
    expect((me.body.access as { state: string }).state).toBe(
      'SUBSCRIPTION_EXPIRED',
    );

    const started = await call(
      'POST',
      `/api/v1/platform/tenants/${tenantId}/subscription`,
      {
        session: platform,
        body: { planId },
      },
    );
    expect(started.body.status).toBe('ACTIVE');
    expect(
      (
        await call(
          'POST',
          `/api/v1/platform/tenants/${tenantId}/subscription`,
          {
            session: platform,
            body: { planId },
          },
        )
      ).body.code,
    ).toBe('SUBSCRIPTION_OPEN');
    const end = new Date(String(started.body.currentPeriodEnd)).getTime();

    const paid = await call(
      'POST',
      `/api/v1/platform/tenants/${tenantId}/payments`,
      {
        session: platform,
        body: {
          amountMinor: 50_000_000,
          reference: `bank-${suffix}`,
          extendSubscription: true,
        },
      },
    );
    expect(paid.status).toBe(201);
    const duplicate = await call(
      'POST',
      `/api/v1/platform/tenants/${tenantId}/payments`,
      {
        session: platform,
        body: { amountMinor: 1, reference: `bank-${suffix}` },
      },
    );
    expect(duplicate.body.code).toBe('DUPLICATE_PAYMENT');
    const history = await call(
      'GET',
      `/api/v1/platform/tenants/${tenantId}/subscription`,
      {
        session: platform,
      },
    );
    const current = history.body.current as {
      currentPeriodEnd: string;
      status: string;
    };
    expect(new Date(current.currentPeriodEnd).getTime() - end).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    expect(
      (await call('GET', '/api/v1/auth/me', { session: owner })).body.access,
    ).toMatchObject({
      state: 'ok',
    });
    const payments = await call(
      'GET',
      `/api/v1/platform/tenants/${tenantId}/payments`,
      {
        session: platform,
      },
    );
    expect(payments.body.payments).toEqual([
      expect.objectContaining({
        provider: 'MANUAL',
        status: 'PAID',
        amountMinor: 50_000_000,
      }),
    ]);
    // The tenant's own read-only view (Settings -> Subscription).
    const own = await call('GET', '/api/v1/subscription', { session: owner });
    expect(own.status).toBe(200);
    expect(own.body.subscription).toMatchObject({
      status: 'ACTIVE',
      planName: 'Basic',
      priceMinor: 50_000_000,
    });
    expect(own.body.access).toMatchObject({ state: 'ok' });
    expect(own.body.payments).toEqual([
      expect.objectContaining({ amountMinor: 50_000_000, status: 'PAID' }),
    ]);
    expect(
      (await call('GET', '/api/v1/subscription', { session: platform })).status,
    ).toBe(401);
  });
});

describe('platform admins', () => {
  it('invites an admin, who sets a password; owners cannot deactivate themselves', async () => {
    const owner = await platformLogin(OWNER_EMAIL);
    const invited = await call('POST', '/api/v1/platform/admins', {
      session: owner,
      body: {
        email: `p-new-${suffix}@example.test`,
        displayName: 'New support',
        role: 'PLATFORM_SUPPORT',
      },
    });
    expect(invited.status).toBe(201);
    const accepted = await call(
      'POST',
      `/api/v1/platform/auth/invites/${String(invited.body.token)}/accept`,
      { body: { password: 'a long platform password' } },
    );
    expect(accepted.status).toBe(200);
    const support = sessionFrom(accepted, 'ac_platform');
    expect(
      (await call('GET', '/api/v1/platform/auth/me', { session: support }))
        .status,
    ).toBe(200);

    const me = (
      await call('GET', '/api/v1/platform/auth/me', { session: owner })
    ).body.admin as { id: string };
    const self = await call(
      'POST',
      `/api/v1/platform/admins/${me.id}/deactivate`,
      { session: owner },
    );
    expect(self.body.code).toBe('SELF_EDIT');
    const off = await call(
      'POST',
      `/api/v1/platform/admins/${String(invited.body.id)}/deactivate`,
      {
        session: owner,
      },
    );
    expect(off.status).toBe(201);
    expect(
      (await call('GET', '/api/v1/platform/auth/me', { session: support }))
        .status,
    ).toBe(401);
    expect(
      await db.platformAuditEvent.count({
        where: {
          entityId: String(invited.body.id),
          action: {
            in: ['admin.invited', 'admin.invite_accepted', 'admin.deactivated'],
          },
        },
      }),
    ).toBe(3);
  });
});
