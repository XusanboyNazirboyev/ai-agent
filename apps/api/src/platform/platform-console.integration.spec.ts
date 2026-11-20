import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceRequests } from '../observability/trace-requests.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import {
  appModuleEnvironment,
  ownerClient,
} from '../persistence/testing/test-clients.js';
import { base32Decode, totpCode } from '../auth/totp.js';
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
// RLS plan S8b: strict runs the app with the main pool on the app role and
// the test owner as the privileged pool; fixtures and checks on the owner.
Object.assign(process.env, appModuleEnvironment());
process.env.NODE_ENV = 'test';
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '1000';
process.env.WEB_ORIGINS = 'http://localhost:3000';
delete process.env.WEB_PROXY_SECRET;

const ORIGIN = 'http://localhost:3000';
const FAST = { N: 1024, r: 8, p: 1 };
const PACK = [...DOMAIN_PACKS.keys()][0] as string;
const db = ownerClient();
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
  // As main.ts: every request gets its tenant slot (RLS plan S4).
  app.use(traceRequests);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  await enrol(OWNER_EMAIL);
  await enrol(SUPPORT_EMAIL);
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

const secrets = new Map<string, string>();

/** First sign-in of a fixture admin: forced enrolment (ADR 048 §5). */
async function enrol(email: string, password = ADMIN_PASSWORD): Promise<void> {
  const login = await call('POST', '/api/v1/platform/auth/login', {
    body: { email, password },
  });
  expect(login.body.mfaEnrollmentRequired).toBe(true);
  const challenge = String(login.body.challenge);
  const setup = await call('POST', '/api/v1/platform/auth/login/mfa/setup', {
    body: { challenge },
  });
  const secret = String(setup.body.secret);
  const done = await call('POST', '/api/v1/platform/auth/login/mfa/enable', {
    body: { challenge, code: totpCode(base32Decode(secret), Date.now()) },
  });
  expect(done.status).toBe(200);
  secrets.set(email, secret);
}

/** Password then code; the replay marker is cleared so tests can sign in repeatedly. */
async function platformLogin(
  email: string,
  password = ADMIN_PASSWORD,
): Promise<Session> {
  await db.platformAdmin.update({
    where: { email },
    data: { totpLastStep: null },
  });
  const login = await call('POST', '/api/v1/platform/auth/login', {
    body: { email, password },
  });
  expect(login.body.mfaRequired).toBe(true);
  const result = await call('POST', '/api/v1/platform/auth/login/mfa', {
    body: {
      challenge: String(login.body.challenge),
      code: totpCode(base32Decode(secrets.get(email)!), Date.now()),
    },
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
    await db.platformAdmin.update({
      where: { email: OWNER_EMAIL },
      data: { totpLastStep: null },
    });
    const first = await call('POST', '/api/v1/platform/auth/login', {
      body: { email: OWNER_EMAIL.toUpperCase(), password: ADMIN_PASSWORD },
    });
    expect(first.body.mfaRequired).toBe(true);
    const login = await call('POST', '/api/v1/platform/auth/login/mfa', {
      body: {
        challenge: String(first.body.challenge),
        code: totpCode(base32Decode(secrets.get(OWNER_EMAIL)!), Date.now()),
      },
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
    // The customer page shows what the open plan allows (null = no limit).
    const detail = await call('GET', `/api/v1/platform/tenants/${tenantId}`, {
      session: platform,
    });
    expect(detail.body.limits).toMatchObject({
      maxOperators: 2,
      maxChannelAccounts: null,
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
    expect(accepted.body.mfaEnrollmentRequired).toBe(true);
    expect(accepted.cookies).toEqual([]);
    const newEmail = `p-new-${suffix}@example.test`;
    await enrol(newEmail, 'a long platform password');
    const support = await platformLogin(newEmail, 'a long platform password');
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

describe('editing and deleting a tenant (ADR 047 amendment 2026-11-17)', () => {
  const slug = `erase-${suffix}`;
  let platform: Session;
  let tenantId = '';

  it('edits the name, default locale, time zone and pack, with an audit entry', async () => {
    platform = await platformLogin(OWNER_EMAIL);
    const created = await call('POST', '/api/v1/platform/tenants', {
      session: platform,
      body: {
        slug,
        name: 'To be erased',
        pack: PACK,
        defaultLocale: 'uz-Latn',
        timezone: 'Asia/Tashkent',
        ownerEmail: `erase-owner-${suffix}@example.test`,
      },
    });
    expect(created.status).toBe(201);
    tenantId = String((created.body.tenant as { id: string }).id);

    const otherPack = [...DOMAIN_PACKS.keys()].at(-1) as string;
    const bad = await call('PATCH', `/api/v1/platform/tenants/${tenantId}`, {
      session: platform,
      body: { timezone: 'Mars/Olympus', reason: 'typo' },
    });
    expect(bad.status).toBe(400);
    const edited = await call('PATCH', `/api/v1/platform/tenants/${tenantId}`, {
      session: platform,
      body: {
        name: 'Renamed tenant',
        defaultLocale: 'en',
        timezone: 'Europe/Istanbul',
        pack: otherPack,
        reason: 'owner asked',
      },
    });
    expect(edited.status).toBe(200);
    const stored = await db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    expect(stored).toMatchObject({
      name: 'Renamed tenant',
      defaultLocale: 'en',
      timezone: 'Europe/Istanbul',
    });
    expect(`${stored.packKey}@${stored.packVersion}`).toBe(otherPack);
    const audit = await db.platformAuditEvent.findFirstOrThrow({
      where: { tenantId, action: 'tenant.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.safeSummary).toMatchObject({
      renamed: true,
      fromLocale: 'uz-Latn',
      toLocale: 'en',
      toTimezone: 'Europe/Istanbul',
      toPack: otherPack,
    });
  });

  it('deletes only an archived tenant whose slug is typed, with everything it owns', async () => {
    // Rows in several tenant-owned tables, including a person merged into
    // another one (a RESTRICT key of a table to itself).
    const account = await db.channelAccount.create({
      data: {
        tenantId,
        channelType: 'test',
        externalAccountId: `erase-${suffix}`,
      },
    });
    const contact = await db.contact.create({
      data: {
        tenantId,
        channelAccountId: account.id,
        providerUserId: `erase-user-${suffix}`,
      },
    });
    const conversation = await db.conversation.create({
      data: {
        tenantId,
        channelAccountId: account.id,
        contactId: contact.id,
        providerChatId: `erase-chat-${suffix}`,
      },
    });
    await db.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        channelAccountId: account.id,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        text: 'salom',
        sequence: 1,
        providerChatId: `erase-chat-${suffix}`,
      },
    });
    const survivor = await db.person.create({ data: { tenantId } });
    await db.person.create({
      data: { tenantId, mergedIntoId: survivor.id },
    });
    // Every real tenant has audit rows; audit_events is append-only
    // (staging 2026-11-19: the delete failed on them with 55000).
    const auditRow = await db.auditEvent.create({
      data: {
        tenantId,
        actorType: 'SYSTEM',
        action: 'test.erase',
        entityType: 'tenant',
        entityId: tenantId,
      },
    });
    const other = await db.tenant.findFirstOrThrow({
      where: { id: { not: tenantId } },
      select: { id: true },
    });
    const otherContacts = await db.contact.count({
      where: { tenantId: other.id },
    });
    const otherAudit = await db.auditEvent.count({
      where: { tenantId: other.id },
    });
    // Outside a tenant erasure the audit log still refuses a delete, an
    // erasure of another tenant does not open it, and an update never passes.
    await expect(
      db.auditEvent.delete({ where: { id: auditRow.id } }),
    ).rejects.toThrow(/append-only/u);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('agentcore.erasing_tenant', ${other.id}, true)`;
        await tx.auditEvent.delete({ where: { id: auditRow.id } });
      }),
    ).rejects.toThrow(/append-only/u);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('agentcore.erasing_tenant', ${tenantId}, true)`;
        await tx.auditEvent.update({
          where: { id: auditRow.id },
          data: { action: 'changed' },
        });
      }),
    ).rejects.toThrow(/append-only/u);

    const path = `/api/v1/platform/tenants/${tenantId}`;
    const active = await call('DELETE', path, {
      session: platform,
      body: { confirmSlug: slug, reason: 'test tenant' },
    });
    expect(active.status).toBe(409);
    expect(active.body.code).toBe('TENANT_NOT_ARCHIVED');
    await call('PATCH', path, {
      session: platform,
      body: { status: 'ARCHIVED', reason: 'test tenant' },
    });
    const support = await platformLogin(SUPPORT_EMAIL);
    expect(
      (
        await call('DELETE', path, {
          session: support,
          body: { confirmSlug: slug, reason: 'test tenant' },
        })
      ).status,
    ).toBe(403);
    const typo = await call('DELETE', path, {
      session: platform,
      body: { confirmSlug: `${slug}x`, reason: 'test tenant' },
    });
    expect(typo.status).toBe(409);
    expect(typo.body.code).toBe('CONFIRMATION_MISMATCH');

    const deleted = await call('DELETE', path, {
      session: platform,
      body: { confirmSlug: slug, reason: 'test tenant' },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({
      deleted: true,
      telegram: { removed: 0, failed: 0 },
    });
    expect(Number(deleted.body.rows)).toBeGreaterThanOrEqual(6);

    expect(await db.tenant.count({ where: { id: tenantId } })).toBe(0);
    for (const count of await Promise.all([
      db.contact.count({ where: { tenantId } }),
      db.message.count({ where: { tenantId } }),
      db.person.count({ where: { tenantId } }),
      db.operatorInvite.count({ where: { tenantId } }),
      db.channelAccount.count({ where: { tenantId } }),
      db.auditEvent.count({ where: { tenantId } }),
    ]))
      expect(count).toBe(0);
    expect(await db.contact.count({ where: { tenantId: other.id } })).toBe(
      otherContacts,
    );
    expect(await db.auditEvent.count({ where: { tenantId: other.id } })).toBe(
      otherAudit,
    );
    // The platform audit keeps the history; its tenant reference is cleared.
    const trail = await db.platformAuditEvent.findMany({
      where: { entityId: tenantId },
      select: { action: true, tenantId: true, safeSummary: true },
    });
    expect(trail.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'tenant.created',
        'tenant.updated',
        'tenant.deleted',
      ]),
    );
    expect(trail.every((entry) => entry.tenantId === null)).toBe(true);
    expect(
      trail.find((entry) => entry.action === 'tenant.deleted')?.safeSummary,
    ).toMatchObject({ slug, reason: 'test tenant' });
    expect(
      (
        await call('DELETE', path, {
          session: platform,
          body: { confirmSlug: slug, reason: 'again' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('password reset links (ADR 047 amendment 2026-11-17)', () => {
  it('a one-time link sets a new password, signs out and retires earlier links', async () => {
    const platform = await platformLogin(OWNER_EMAIL);
    const slug = `reset-${suffix}`;
    const email = `reset-owner-${suffix}@example.test`;
    const created = await call('POST', '/api/v1/platform/tenants', {
      session: platform,
      body: {
        slug,
        name: 'Reset tenant',
        pack: PACK,
        defaultLocale: 'uz-Latn',
        timezone: 'Asia/Tashkent',
        ownerEmail: email,
      },
    });
    expect(created.status).toBe(201);
    const tenantId = String((created.body.tenant as { id: string }).id);
    const invite = created.body.invite as { token: string };
    const owner = await accept(invite.token, 'Owner', 'old owner password');
    const operatorId = (
      await db.operator.findFirstOrThrow({ where: { tenantId } })
    ).id;
    const issue = (): Promise<Result> =>
      call(
        'POST',
        `/api/v1/platform/tenants/${tenantId}/operators/${operatorId}/password-reset`,
        { session: platform },
      );

    // SUPPORT cannot issue one; the owner of the tenant cannot for themselves.
    const support = await platformLogin(SUPPORT_EMAIL);
    expect(
      (
        await call(
          'POST',
          `/api/v1/platform/tenants/${tenantId}/operators/${operatorId}/password-reset`,
          { session: support },
        )
      ).status,
    ).toBe(403);
    const self = await call(
      'POST',
      `/api/v1/team/operators/${operatorId}/password-reset`,
      { session: owner },
    );
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_EDIT');

    const first = await issue();
    expect(first.status).toBe(201);
    const second = await issue();
    const firstToken = String(first.body.path).replace('/reset/', '');
    const token = String(second.body.path).replace('/reset/', '');
    expect(second.body.email).toBe(email);
    // A new link retires the previous one.
    expect(
      (await call('GET', `/api/v1/auth/password-resets/${firstToken}`)).status,
    ).toBe(404);
    const preview = await call('GET', `/api/v1/auth/password-resets/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ email, tenantName: 'Reset tenant' });

    expect(
      (
        await call('POST', `/api/v1/auth/password-resets/${token}`, {
          body: { password: 'short' },
        })
      ).status,
    ).toBe(400);
    const done = await call('POST', `/api/v1/auth/password-resets/${token}`, {
      body: { password: 'new owner password' },
    });
    expect(done.status).toBe(200);
    // Signed out everywhere; only the new password works; the link is spent.
    expect(
      (await call('GET', '/api/v1/auth/me', { session: owner })).status,
    ).toBe(401);
    expect((await tenantLogin(email, 'old owner password')).status).toBe(401);
    expect((await tenantLogin(email, 'new owner password')).status).toBe(200);
    expect(
      (
        await call('POST', `/api/v1/auth/password-resets/${token}`, {
          body: { password: 'another owner password' },
        })
      ).status,
    ).toBe(404);
    const audit = await db.platformAuditEvent.count({
      where: { tenantId, action: 'operator.password_reset_issued' },
    });
    expect(audit).toBe(2);
    expect(
      await db.auditEvent.count({
        where: { tenantId, action: 'operator.password_reset' },
      }),
    ).toBe(1);
  });
});

describe('tenant invites from the console', () => {
  it('lists, creates and revokes an invite of one tenant', async () => {
    const platform = await platformLogin(OWNER_EMAIL);
    const created = await call('POST', '/api/v1/platform/tenants', {
      session: platform,
      body: {
        slug: `invites-${suffix}`,
        name: 'Invites tenant',
        pack: PACK,
        defaultLocale: 'uz-Latn',
        timezone: 'Asia/Tashkent',
        ownerEmail: `invites-owner-${suffix}@example.test`,
      },
    });
    expect(created.status).toBe(201);
    const tenantId = String((created.body.tenant as { id: string }).id);
    const path = `/api/v1/platform/tenants/${tenantId}/invites`;
    const pending = async (): Promise<string[]> => {
      const list = await call('GET', path, { session: platform });
      expect(list.status).toBe(200);
      return (list.body.invites as { role: string }[]).map((i) => i.role);
    };
    expect(await pending()).toEqual(['OWNER']);

    const invite = await call('POST', path, {
      session: platform,
      body: { email: `invites-admin-${suffix}@example.test`, role: 'ADMIN' },
    });
    expect(invite.status).toBe(201);
    expect(await pending()).toEqual(['ADMIN', 'OWNER']);

    const revoked = await call('DELETE', `${path}/${String(invite.body.id)}`, {
      session: platform,
    });
    expect(revoked.status).toBe(204);
    expect(await pending()).toEqual(['OWNER']);
  });
});

/**
 * Overview (ADR 047 amendment 2026-11-19). The shared test database holds
 * other tests' tenants, so company/trial/churn/activity counts are compared
 * as deltas before/after seeding; money uses two currency codes no other
 * test uses (XTA, XTB), so those figures are exact.
 */
describe('platform overview', () => {
  interface OverviewBody {
    companies: {
      total: number;
      byStatus: Record<string, number>;
      bySubscription: Record<string, number>;
    };
    trialsEndingSoon: number;
    months: {
      month: string;
      newCompanies: number;
      trialsStarted: number;
      convertedToPaid: number;
      churned: number;
      activeCompanies: number;
      revenue: Record<string, string>;
    }[];
    revenue: Record<
      'allTime' | 'thisMonth' | 'lastMonth' | 'mrr',
      Record<string, string>
    >;
    usageThisMonth: { conversations: number; inboundMessages: number };
    recent: { kind: string; tenantName: string; tenantId: string }[];
  }
  const ovr = async (session: Session, query = ''): Promise<OverviewBody> => {
    const result = await call('GET', `/api/v1/platform/overview${query}`, {
      session,
    });
    expect(result.status).toBe(200);
    return result.body as unknown as OverviewBody;
  };
  const letter = (index: number): string =>
    String.fromCharCode(65 + (Number.parseInt(suffix[index]!, 16) % 26));
  // Random per run, so earlier runs' rows never mix into the exact sums.
  const CUR_A = `X${letter(0)}${letter(1)}`;
  const CUR_B = `Y${letter(2)}${letter(3)}`;
  const seededTenants: string[] = [];
  const seededPlans: string[] = [];
  afterAll(async () => {
    await db.tenant.deleteMany({ where: { id: { in: seededTenants } } });
    await db.subscriptionPlan.deleteMany({
      where: { id: { in: seededPlans } },
    });
  });
  const ago = (days: number): Date => new Date(Date.now() - days * 86_400_000);

  it('aggregates companies, trials, conversions, churn and revenue', async () => {
    const support = await platformLogin(SUPPORT_EMAIL);
    const before = await ovr(support);
    const keys = before.months.map((m) => m.month);
    expect(keys).toHaveLength(12);
    const m0 = keys[11]!;
    const m1 = keys[10]!;
    const lastMonth = new Date(`${m1}-15T07:00:00Z`);
    const thisMonth = new Date(`${m0}-02T07:00:00Z`);
    const planA = await db.subscriptionPlan.create({
      data: {
        code: `ov-a-${suffix}`,
        name: 'Overview A',
        priceMinor: 3_000_000n,
        currency: CUR_A,
        periodDays: 30,
      },
    });
    const planB = await db.subscriptionPlan.create({
      data: {
        code: `ov-b-${suffix}`,
        name: 'Overview B',
        priceMinor: 36_500n,
        currency: CUR_B,
        periodDays: 365,
      },
    });
    seededPlans.push(planA.id, planB.id);
    const mk = (
      key: string,
      createdAt: Date,
      status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
    ): Promise<{ id: string; name: string }> =>
      db.tenant
        .create({
          data: {
            slug: `ov-${key}-${suffix}`,
            name: `Overview ${key} ${suffix}`,
            status,
            defaultLocale: 'en',
            supportedLocales: ['en'],
            timezone: 'UTC',
            packKey: PACK,
            packVersion: '1',
            createdAt,
          },
          select: { id: true, name: true },
        })
        .then((row) => {
          seededTenants.push(row.id);
          return row;
        });
    const sub = (
      tenantId: string,
      planId: string,
      status: 'TRIAL' | 'ACTIVE' | 'EXPIRED',
      createdAt: Date,
      end: Date,
    ): Promise<unknown> =>
      db.tenantSubscription.create({
        data: {
          tenantId,
          planId,
          status,
          currentPeriodStart: createdAt,
          currentPeriodEnd: end,
          createdAt,
        },
      });
    const audit = (
      tenantId: string,
      action: string,
      createdAt: Date,
      safeSummary: Record<string, string> = {},
    ): Promise<unknown> =>
      db.platformAuditEvent.create({
        data: {
          action,
          tenantId,
          entityType: 'tenant_subscription',
          entityId: 'x',
          safeSummary,
          createdAt,
        },
      });
    const pay = (
      tenantId: string,
      currency: string,
      amountMinor: bigint,
      status: 'PAID' | 'REFUNDED',
      paidAt: Date,
      ref: string,
    ): Promise<unknown> =>
      db.subscriptionPayment.create({
        data: {
          tenantId,
          provider: 'MANUAL',
          providerRef: `manual:ov-${ref}-${suffix}`,
          amountMinor,
          currency,
          status,
          paidAt,
        },
      });

    // A: trial last month, converted (first payment last month), pays again now.
    const a = await mk('a', lastMonth);
    await audit(a.id, 'subscription.started', lastMonth, { status: 'TRIAL' });
    await sub(a.id, planA.id, 'ACTIVE', lastMonth, ago(-20));
    await pay(a.id, CUR_A, 3_000_000n, 'PAID', lastMonth, 'a1');
    await pay(a.id, CUR_A, 3_000_000n, 'PAID', thisMonth, 'a2');
    // B: trial last month, ends in two days.
    const b = await mk('b', lastMonth);
    await audit(b.id, 'subscription.started', lastMonth, { status: 'TRIAL' });
    await sub(b.id, planA.id, 'TRIAL', lastMonth, ago(-2));
    // C: trial this month, expired this month: churned.
    const c = await mk('c', thisMonth);
    await audit(c.id, 'subscription.started', thisMonth, { status: 'TRIAL' });
    await audit(c.id, 'subscription.expired', thisMonth);
    await sub(c.id, planA.id, 'EXPIRED', thisMonth, ago(1));
    // D: paid without a trial, cancel event last month but an open row now
    // (re-subscribed): not churned. A refunded payment is excluded.
    const d = await mk('d', lastMonth);
    await audit(d.id, 'subscription.canceled', lastMonth);
    await sub(d.id, planB.id, 'ACTIVE', lastMonth, ago(-300));
    await pay(d.id, CUR_B, 36_500n, 'PAID', lastMonth, 'd1');
    await pay(d.id, CUR_B, 99_999n, 'REFUNDED', lastMonth, 'd2');
    // E: archived, never subscribed.
    const e = await mk('e', thisMonth, 'ARCHIVED');
    // Activity of A: one customer message last month and one this month.
    const channel = await db.channelAccount.create({
      data: {
        tenantId: a.id,
        channelType: 'telegram',
        externalAccountId: `ov-${suffix}`,
        status: 'DISABLED',
      },
    });
    const contact = await db.contact.create({
      data: {
        tenantId: a.id,
        channelAccountId: channel.id,
        providerUserId: `ov-${suffix}`,
      },
    });
    const conversation = await db.conversation.create({
      data: {
        tenantId: a.id,
        channelAccountId: channel.id,
        contactId: contact.id,
        providerChatId: `ov-${suffix}`,
        createdAt: thisMonth,
        lastInboundAt: thisMonth,
      },
    });
    for (const [sequence, createdAt] of [lastMonth, thisMonth].entries())
      await db.message.create({
        data: {
          tenantId: a.id,
          conversationId: conversation.id,
          channelAccountId: channel.id,
          authorType: 'CUSTOMER',
          direction: 'INBOUND',
          text: 'hi',
          sequence: sequence + 1,
          providerChatId: `ov-${suffix}`,
          createdAt,
        },
      });
    // The newest event wins the "recent" list.
    await db.platformAuditEvent.create({
      data: {
        action: 'payment.recorded',
        tenantId: d.id,
        entityType: 'subscription_payment',
        entityId: 'y',
        createdAt: new Date(Date.now() + 120_000),
      },
    });

    // The customer list shows the last inbound message per company.
    const listed = await call(
      'GET',
      `/api/v1/platform/tenants?q=ov-a-${suffix}`,
      { session: support },
    );
    const rows = listed.body.tenants as {
      id: string;
      lastInboundAt: string | null;
    }[];
    expect(rows.find((row) => row.id === a.id)?.lastInboundAt).toBe(
      thisMonth.toISOString(),
    );
    const listedB = await call(
      'GET',
      `/api/v1/platform/tenants?q=ov-b-${suffix}`,
      { session: support },
    );
    expect(
      (listedB.body.tenants as { lastInboundAt: unknown }[])[0]?.lastInboundAt,
    ).toBeNull();

    const after = await ovr(support);
    const delta = (pick: (o: OverviewBody) => number): number =>
      pick(after) - pick(before);
    expect(delta((o) => o.companies.total)).toBe(5);
    expect(delta((o) => o.companies.byStatus.ARCHIVED!)).toBe(1);
    expect(delta((o) => o.companies.bySubscription.TRIAL!)).toBe(1);
    expect(delta((o) => o.companies.bySubscription.ACTIVE!)).toBe(2);
    expect(delta((o) => o.companies.bySubscription.EXPIRED!)).toBe(1);
    expect(delta((o) => o.companies.bySubscription.NONE!)).toBe(1);
    expect(delta((o) => o.trialsEndingSoon)).toBe(1);
    expect(e.id).toBeTruthy();
    const month = (
      o: OverviewBody,
      key: string,
    ): OverviewBody['months'][number] => o.months.find((m) => m.month === key)!;
    const md = (
      key: string,
      field:
        | 'newCompanies'
        | 'trialsStarted'
        | 'convertedToPaid'
        | 'churned'
        | 'activeCompanies',
    ): number => month(after, key)[field] - month(before, key)[field];
    expect(md(m1, 'newCompanies')).toBe(3);
    expect(md(m0, 'newCompanies')).toBe(2);
    expect(md(m1, 'trialsStarted')).toBe(2);
    expect(md(m0, 'trialsStarted')).toBe(1);
    expect(md(m1, 'convertedToPaid')).toBe(1);
    expect(md(m0, 'convertedToPaid')).toBe(0);
    expect(md(m1, 'churned')).toBe(0);
    expect(md(m0, 'churned')).toBe(1);
    expect(md(m1, 'activeCompanies')).toBe(1);
    expect(md(m0, 'activeCompanies')).toBe(1);
    // Exact money (a random currency code per run).
    expect(month(after, m1).revenue).toMatchObject({
      [CUR_A]: '30000.00',
      [CUR_B]: '365.00',
    });
    expect(month(after, m0).revenue[CUR_A]).toBe('30000.00');
    expect(month(after, m0).revenue.XTB).toBeUndefined();
    expect(after.revenue.allTime).toMatchObject({
      [CUR_A]: '60000.00',
      [CUR_B]: '365.00',
    });
    expect(after.revenue.thisMonth[CUR_A]).toBe('30000.00');
    expect(after.revenue.lastMonth).toMatchObject({
      [CUR_A]: '30000.00',
      [CUR_B]: '365.00',
    });
    // MRR: A pays 3 000 000 / 30 days; D 36 500 per 365 days = 3 000 per 30.
    expect(after.revenue.mrr).toMatchObject({
      [CUR_A]: '30000.00',
      [CUR_B]: '30.00',
    });
    expect(delta((o) => o.usageThisMonth.conversations)).toBe(1);
    expect(delta((o) => o.usageThisMonth.inboundMessages)).toBe(1);
    expect(after.recent).toHaveLength(10);
    expect(after.recent[0]).toMatchObject({
      kind: 'payment.recorded',
      tenantId: d.id,
      tenantName: d.name,
    });
    // months=1 still knows last month.
    const one = await ovr(support, '?months=1');
    expect(one.months).toHaveLength(1);
    expect(one.revenue.lastMonth[CUR_A]).toBe('30000.00');
  });

  it('refuses bad queries and non-platform callers', async () => {
    const owner = await platformLogin(OWNER_EMAIL);
    for (const query of ['?months=0', '?months=25', '?months=x', '?foo=1'])
      expect(
        (
          await call('GET', `/api/v1/platform/overview${query}`, {
            session: owner,
          })
        ).status,
      ).toBe(400);
    expect((await call('GET', '/api/v1/platform/overview')).status).toBe(401);
    expect(
      (
        await call('GET', '/api/v1/platform/overview', {
          session: { cookie: `ac_session=${randomUUID()}`, csrf: '' },
        })
      ).status,
    ).toBe(401);
  });
});

describe('available plans for customer creation', () => {
  it('searches all active plans and pages newest first past 200 with stable timestamp ties', async () => {
    const session = await platformLogin(OWNER_EMAIL);
    const prefix = `choices-${randomUUID().slice(0, 8)}`;
    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: randomUUID(),
      code: `${prefix}-${index}`,
      name: `${prefix} Plan ${index}`,
      priceMinor: 100n,
      currency: 'UZS',
      periodDays: 30,
      isActive: true,
      createdAt: new Date(
        index === 204 ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z',
      ),
    }));
    await db.subscriptionPlan.createMany({
      data: [
        ...rows,
        {
          ...rows[204]!,
          id: randomUUID(),
          code: `${prefix}-inactive`,
          isActive: false,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        },
      ],
    });
    // PostgreSQL stores microseconds that a JS Date cannot represent.
    await db.$executeRaw`UPDATE subscription_plans SET created_at = created_at + interval '123 microseconds' WHERE code LIKE ${`${prefix}-%`}`;
    const expected = [...rows]
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      )
      .map((row) => row.id);
    const first = await call(
      'GET',
      `/api/v1/platform/plans/available?q=${prefix.toUpperCase()}`,
      { session },
    );
    expect(first.status).toBe(200);
    const firstPlans = first.body.plans as { id: string; isActive: boolean }[];
    expect(firstPlans).toHaveLength(25);
    expect(firstPlans.map((plan) => plan.id)).toEqual(expected.slice(0, 25));
    const seen = firstPlans.map((plan) => plan.id);
    let cursor = first.body.nextCursor as string | null;
    // A new top item and a deactivated boundary must not shift later pages.
    await db.subscriptionPlan.create({
      data: {
        ...rows[204]!,
        id: randomUUID(),
        code: `${prefix}-inserted`,
        createdAt: new Date('2026-01-04T00:00:00Z'),
      },
    });
    await db.subscriptionPlan.update({
      where: { id: seen.at(-1)! },
      data: { isActive: false },
    });
    for (let page = 0; cursor && page < 10; page += 1) {
      const result = await call(
        'GET',
        `/api/v1/platform/plans/available?q=${prefix}&limit=40&cursor=${encodeURIComponent(cursor)}`,
        { session },
      );
      expect(result.status).toBe(200);
      const plans = result.body.plans as { id: string; isActive: boolean }[];
      expect(plans.length).toBeLessThanOrEqual(40);
      expect(plans.every((plan) => plan.isActive)).toBe(true);
      seen.push(...plans.map((plan) => plan.id));
      cursor = result.body.nextCursor as string | null;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(205);
    const byCode = await call(
      'GET',
      `/api/v1/platform/plans/available?q=${rows[0]!.code.toUpperCase()}`,
      { session },
    );
    expect(
      (byCode.body.plans as { id: string }[]).map((plan) => plan.id),
    ).toContain(rows[0]!.id);
    const newest = await call(
      'GET',
      `/api/v1/platform/plans/available?q=${prefix}&limit=1`,
      { session },
    );
    expect((newest.body.plans as { code: string }[])[0]?.code).toBe(
      `${prefix}-inserted`,
    );
  });

  it('matches names and literal wildcard characters, and returns an empty final page', async () => {
    const session = await platformLogin(SUPPORT_EMAIL);
    const prefix = `literal-${randomUUID().slice(0, 8)}`;
    await db.subscriptionPlan.createMany({
      data: [
        {
          code: `${prefix}-one`,
          name: `${prefix}%_ Choice`,
          priceMinor: 100n,
          periodDays: 30,
        },
        {
          code: `${prefix}-two`,
          name: `${prefix}XY Choice`,
          priceMinor: 100n,
          periodDays: 30,
        },
      ],
    });
    const found = await call(
      'GET',
      `/api/v1/platform/plans/available?q=${encodeURIComponent(`${prefix.toUpperCase()}%_`)}`,
      { session },
    );
    expect(found.status).toBe(200);
    expect(
      (found.body.plans as { code: string }[]).map((plan) => plan.code),
    ).toEqual([`${prefix}-one`]);
    expect(found.body.nextCursor).toBeNull();
    const empty = await call(
      'GET',
      `/api/v1/platform/plans/available?q=absent-${prefix}`,
      { session },
    );
    expect(empty.body).toEqual({ plans: [], nextCursor: null });
  });

  it('requires a platform session and rejects invalid search, page size and cursor values', async () => {
    expect((await call('GET', '/api/v1/platform/plans/available')).status).toBe(
      401,
    );
    const session = await platformLogin(OWNER_EMAIL);
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      `q=${'a'.repeat(201)}`,
      'cursor=broken',
      'cursor=e30',
      'q=a&q=b',
    ]) {
      expect(
        (
          await call('GET', `/api/v1/platform/plans/available?${query}`, {
            session,
          })
        ).status,
        query,
      ).toBe(400);
    }
  });
});
