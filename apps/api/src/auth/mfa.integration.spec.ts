import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { PlatformSessionService } from '../platform/platform-session.service.js';
import { hashPassword } from '../webinbox/password.js';
import { SessionService } from '../webinbox/session.service.js';
import { MfaError, MfaService } from './mfa.service.js';
import { base32Decode, totpCode } from './totp.js';

/**
 * ADR 048 over HTTP on the real AppModule and database: two-step sign-in for
 * tenant operators and platform admins, forced platform enrolment, replay,
 * challenge expiry and attempt limit, recovery codes, lockout, and the
 * missing-keyring refusal. The keyring is a throwaway key set below.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('MFA tests require agentcore_test');
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
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString('base64');
delete process.env.SECRETS_KEY_ID;
delete process.env.SECRETS_PREVIOUS_KEYS;
delete process.env.WEB_PROXY_SECRET;

const FAST = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const suffix = randomUUID().slice(0, 8);
let app: INestApplication;
let base = '';
let tenantId = '';

beforeAll(async () => {
  const tenant = await db.tenant.create({
    data: {
      slug: `mfa-${suffix}`,
      name: 'MFA test',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  tenantId = tenant.id;
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

interface Result {
  status: number;
  body: Record<string, unknown>;
  cookies: string[];
}
interface Session {
  cookie: string;
  csrf: string;
}

async function call(
  method: string,
  path: string,
  options: { session?: Session; body?: unknown } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.session) {
    headers.cookie = options.session.cookie;
    headers['x-csrf-token'] = options.session.csrf;
  }
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

/** The code of the step after the current one: valid once, and never an already used one. */
const nextCode = (secret: string, stepsAhead = 1): string =>
  totpCode(base32Decode(secret), Date.now() + stepsAhead * 30_000);

const TENANT = {
  login: '/api/v1/auth/login',
  mfa: '/api/v1/auth/login/mfa',
  prefix: '/api/v1/auth/mfa',
  cookie: 'ac_session',
};
const PLATFORM = {
  login: '/api/v1/platform/auth/login',
  mfa: '/api/v1/platform/auth/login/mfa',
  prefix: '/api/v1/platform/auth/mfa',
  cookie: 'ac_platform',
};

async function newOperator(label: string): Promise<{
  email: string;
  operatorId: string;
}> {
  const operator = await db.operator.create({
    data: { tenantId, displayName: `${label}-${suffix}`, role: 'ADMIN' },
  });
  const email = `${label}-${suffix}@example.test`;
  await db.operatorCredential.create({
    data: {
      tenantId,
      operatorId: operator.id,
      email,
      passwordHash: await hashPassword(PASSWORD, FAST),
    },
  });
  return { email, operatorId: operator.id };
}

async function newAdmin(
  label: string,
  role: 'PLATFORM_OWNER' | 'PLATFORM_SUPPORT' = 'PLATFORM_OWNER',
): Promise<{ email: string; id: string }> {
  const email = `p-${label}-${suffix}@example.test`;
  const admin = await db.platformAdmin.create({
    data: {
      email,
      displayName: label,
      role,
      passwordHash: await hashPassword(PASSWORD, FAST),
    },
  });
  return { email, id: admin.id };
}

/** Clears the replay marker and failure counters so one test can sign in again within the same step. */
async function rewindOperator(email: string): Promise<void> {
  await db.operatorCredential.update({
    where: { email },
    data: { totpLastStep: null, failedAttempts: 0, lockedUntil: null },
  });
}
async function rewindAdmin(email: string): Promise<void> {
  await db.platformAdmin.update({
    where: { email },
    data: { totpLastStep: null, failedAttempts: 0, lockedUntil: null },
  });
}

const passwordLogin = (
  api: typeof TENANT,
  email: string,
  password = PASSWORD,
): Promise<Result> => call('POST', api.login, { body: { email, password } });

/** Enrols an account that already has a session (tenant, or a platform admin after forced enrolment). */
async function enrolWithSession(
  api: typeof TENANT,
  session: Session,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await call('POST', `${api.prefix}/setup`, { session });
  expect(setup.status).toBe(200);
  const secret = String(setup.body.secret);
  const enable = await call('POST', `${api.prefix}/enable`, {
    session,
    body: { code: nextCode(secret, 0) },
  });
  expect(enable.status).toBe(200);
  return { secret, recoveryCodes: enable.body.recoveryCodes as string[] };
}

describe('tenant operator two-step sign-in', () => {
  let email = '';
  let operatorId = '';
  let secret = '';
  let recoveryCodes: string[] = [];

  it('signs in with a password alone until MFA is enrolled, then enrols', async () => {
    ({ email, operatorId } = await newOperator('op'));
    const login = await passwordLogin(TENANT, email);
    expect(login.status).toBe(200);
    const session = sessionFrom(login, 'ac_session');
    const before = await call('GET', TENANT.prefix, { session });
    expect(before.body).toMatchObject({
      available: true,
      enabled: false,
      pending: false,
      required: false,
    });
    const early = await call('POST', `${TENANT.prefix}/enable`, {
      session,
      body: { code: '123456' },
    });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('MFA_SETUP_REQUIRED');

    const setup = await call('POST', `${TENANT.prefix}/setup`, { session });
    expect(setup.status).toBe(200);
    secret = String(setup.body.secret);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(String(setup.body.otpauthUri)).toBe(
      `otpauth://totp/tezda:${encodeURIComponent(email)}?secret=${secret}&issuer=tezda`,
    );
    const pending = await call('GET', TENANT.prefix, { session });
    expect(pending.body).toMatchObject({ enabled: false, pending: true });
    expect(JSON.stringify(pending.body)).not.toContain(secret);

    const wrong = await call('POST', `${TENANT.prefix}/enable`, {
      session,
      body: { code: '000000' === nextCode(secret, 0) ? '111111' : '000000' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('MFA_INVALID_CODE');

    const enable = await call('POST', `${TENANT.prefix}/enable`, {
      session,
      body: { code: nextCode(secret, 0) },
    });
    expect(enable.status).toBe(200);
    recoveryCodes = enable.body.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);
    const again = await call('POST', `${TENANT.prefix}/setup`, { session });
    expect(again.status).toBe(409);

    // The secret is sealed: not in the row in clear, and the row says it is on.
    const row = await db.operatorCredential.findUniqueOrThrow({
      where: { email },
    });
    expect(row.totpEnabledAt).not.toBeNull();
    expect(Buffer.from(row.totpCiphertext!).toString('latin1')).not.toContain(
      secret,
    );
    expect(row.mfaRecoveryHashes).toHaveLength(10);
    expect(row.mfaRecoveryHashes.join()).not.toContain(
      recoveryCodes[0]!.replace('-', ''),
    );
    const audit = await db.auditEvent.findMany({
      where: { tenantId, action: 'auth.mfa_enabled', entityId: operatorId },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('returns a challenge instead of a session, then signs in with a code', async () => {
    const login = await passwordLogin(TENANT, email);
    expect(login.status).toBe(200);
    expect(login.cookies).toEqual([]);
    expect(login.body.mfaRequired).toBe(true);
    const challenge = String(login.body.challenge);
    expect(login.body.csrfToken).toBeUndefined();

    const done = await call('POST', TENANT.mfa, {
      body: { challenge, code: nextCode(secret, 1) },
    });
    expect(done.status).toBe(200);
    const session = sessionFrom(done, 'ac_session');
    const me = await call('GET', '/api/v1/auth/me', { session });
    expect(me.status).toBe(200);

    // The challenge is single use.
    const reuse = await call('POST', TENANT.mfa, {
      body: { challenge, code: nextCode(secret, 1) },
    });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('MFA_CHALLENGE_INVALID');
  });

  it('refuses a code that was already used (replay)', async () => {
    // The previous test accepted the next step's code; it is now the last step.
    const login = await passwordLogin(TENANT, email);
    const replay = await call('POST', TENANT.mfa, {
      body: {
        challenge: String(login.body.challenge),
        code: nextCode(secret, 1),
      },
    });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('MFA_INVALID_CODE');
    await rewindOperator(email);
  });

  it('expires a challenge and limits it to five attempts', async () => {
    const stale = await passwordLogin(TENANT, email);
    await db.mfaChallenge.updateMany({
      where: { principalId: operatorId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await call('POST', TENANT.mfa, {
      body: {
        challenge: String(stale.body.challenge),
        code: nextCode(secret, 0),
      },
    });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('MFA_CHALLENGE_INVALID');

    const login = await passwordLogin(TENANT, email);
    const challenge = String(login.body.challenge);
    const wrong = (): Promise<Result> =>
      call('POST', TENANT.mfa, { body: { challenge, code: '000000' } });
    for (let i = 0; i < 3; i += 1)
      expect((await wrong()).body.code).toBe('MFA_INVALID_CODE');
    await rewindOperator(email); // keep the account lock out of this check
    for (let i = 0; i < 2; i += 1)
      expect((await wrong()).body.code).toBe('MFA_INVALID_CODE');
    await rewindOperator(email);
    const sixth = await call('POST', TENANT.mfa, {
      body: { challenge, code: nextCode(secret, 0) },
    });
    expect(sixth.status).toBe(401);
    expect(sixth.body.code).toBe('MFA_CHALLENGE_INVALID');
  });

  it('counts wrong codes toward the account lock', async () => {
    await rewindOperator(email);
    let last: Result | undefined;
    for (let i = 0; i < 5; i += 1) {
      const login = await passwordLogin(TENANT, email);
      last = await call('POST', TENANT.mfa, {
        body: { challenge: String(login.body.challenge), code: '000000' },
      });
    }
    expect(last?.status).toBe(401);
    expect(last?.body.code).toBe('LOCKED');
    const locked = await passwordLogin(TENANT, email);
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('LOCKED');
    await rewindOperator(email);
  });

  it('accepts each recovery code once and audits it', async () => {
    const code = recoveryCodes[0]!;
    const login = await passwordLogin(TENANT, email);
    const done = await call('POST', TENANT.mfa, {
      body: { challenge: String(login.body.challenge), recoveryCode: code },
    });
    expect(done.status).toBe(200);
    const second = await passwordLogin(TENANT, email);
    const reuse = await call('POST', TENANT.mfa, {
      body: {
        challenge: String(second.body.challenge),
        recoveryCode: code.toLowerCase().replace('-', ' '),
      },
    });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('MFA_INVALID_CODE');
    const events = await db.auditEvent.findMany({
      where: {
        tenantId,
        action: 'auth.mfa_recovery_used',
        entityId: operatorId,
      },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(code);
    await rewindOperator(email);
  });

  it('regenerates recovery codes (old ones stop working) and disables with password and code', async () => {
    const login = await passwordLogin(TENANT, email);
    const done = await call('POST', TENANT.mfa, {
      body: {
        challenge: String(login.body.challenge),
        code: nextCode(secret, 0),
      },
    });
    const session = sessionFrom(done, 'ac_session');
    const wrongCode = await call('POST', `${TENANT.prefix}/recovery-codes`, {
      session,
      body: { code: '000000' },
    });
    expect(wrongCode.status).toBe(400);
    await rewindOperator(email);
    const fresh = await call('POST', `${TENANT.prefix}/recovery-codes`, {
      session,
      body: { code: nextCode(secret, 1) },
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    const status = await call('GET', TENANT.prefix, { session });
    expect(status.body.recoveryCodesRemaining).toBe(10);

    const badPassword = await call('POST', `${TENANT.prefix}/disable`, {
      session,
      body: { password: 'wrong password', code: nextCode(secret, 1) },
    });
    expect(badPassword.status).toBe(400);
    await rewindOperator(email);
    const off = await call('POST', `${TENANT.prefix}/disable`, {
      session,
      body: { password: PASSWORD, code: nextCode(secret, 0) },
    });
    expect(off.status).toBe(204);
    const row = await db.operatorCredential.findUniqueOrThrow({
      where: { email },
    });
    expect(row.totpEnabledAt).toBeNull();
    expect(row.totpCiphertext).toBeNull();
    expect(row.mfaRecoveryHashes).toEqual([]);
    const direct = await passwordLogin(TENANT, email);
    expect(direct.body.mfaRequired).toBeUndefined();
    expect(direct.cookies.length).toBeGreaterThan(0);
    const actions = (
      await db.auditEvent.findMany({
        where: {
          tenantId,
          entityId: operatorId,
          action: { startsWith: 'auth.mfa_' },
        },
      })
    ).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.mfa_enabled',
        'auth.mfa_recovery_regenerated',
        'auth.mfa_disabled',
      ]),
    );
  });

  it('keeps operators of other tenants and platform admins out of the picture', async () => {
    const other = await newOperator('other');
    const login = await passwordLogin(TENANT, other.email);
    expect(login.body.mfaRequired).toBeUndefined();
    const wrongKind = await call('POST', PLATFORM.login, {
      body: { email: other.email, password: PASSWORD },
    });
    expect(wrongKind.status).toBe(401);
  });
});

describe('platform admin forced enrolment and sign-in', () => {
  let email = '';
  let adminId = '';
  let secret = '';

  it('answers a correct password without MFA with an enrolment challenge and no session', async () => {
    ({ email, id: adminId } = await newAdmin('owner'));
    const login = await passwordLogin(PLATFORM, email);
    expect(login.status).toBe(200);
    expect(login.cookies).toEqual([]);
    expect(login.body.mfaEnrollmentRequired).toBe(true);
    const challenge = String(login.body.challenge);

    // An enrolment challenge opens nothing else.
    const asLogin = await call('POST', PLATFORM.mfa, {
      body: { challenge, code: '123456' },
    });
    expect(asLogin.status).toBe(401);
    const noEnable = await call('POST', `${PLATFORM.mfa}/enable`, {
      body: { challenge, code: '123456' },
    });
    expect(noEnable.status).toBe(409);
    expect(noEnable.body.code).toBe('MFA_SETUP_REQUIRED');

    const setup = await call('POST', `${PLATFORM.mfa}/setup`, {
      body: { challenge },
    });
    expect(setup.status).toBe(200);
    secret = String(setup.body.secret);
    const wrong = await call('POST', `${PLATFORM.mfa}/enable`, {
      body: { challenge, code: '000000' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.cookies).toEqual([]);
    const enable = await call('POST', `${PLATFORM.mfa}/enable`, {
      body: { challenge, code: nextCode(secret, 0) },
    });
    expect(enable.status).toBe(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);
    const session = sessionFrom(enable, 'ac_platform');
    const me = await call('GET', '/api/v1/platform/auth/me', { session });
    expect(me.status).toBe(200);
    const reuse = await call('POST', `${PLATFORM.mfa}/setup`, {
      body: { challenge },
    });
    expect(reuse.status).toBe(401);
    const audit = await db.platformAuditEvent.findMany({
      where: { entityId: adminId, action: 'auth.mfa_enabled' },
    });
    expect(audit).toHaveLength(1);
  });

  it('then needs a code at every sign-in, and a replayed one is refused', async () => {
    const login = await passwordLogin(PLATFORM, email);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.cookies).toEqual([]);
    const challenge = String(login.body.challenge);
    const done = await call('POST', PLATFORM.mfa, {
      body: { challenge, code: nextCode(secret, 1) },
    });
    expect(done.status).toBe(200);
    const session = sessionFrom(done, 'ac_platform');
    const again = await passwordLogin(PLATFORM, email);
    const replay = await call('POST', PLATFORM.mfa, {
      body: {
        challenge: String(again.body.challenge),
        code: nextCode(secret, 1),
      },
    });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('MFA_INVALID_CODE');

    const off = await call('POST', `${PLATFORM.prefix}/disable`, {
      session,
      body: { password: PASSWORD, code: nextCode(secret, 1) },
    });
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('MFA_REQUIRED_BY_POLICY');
    const status = await call('GET', PLATFORM.prefix, { session });
    expect(status.body).toMatchObject({ enabled: true, required: true });
    await rewindAdmin(email);
  });

  it('accepts a recovery code once and locks after five wrong codes', async () => {
    const codes = await db.platformAdmin.findUniqueOrThrow({
      where: { email },
    });
    expect(codes.mfaRecoveryHashes).toHaveLength(10);
    let last: Result | undefined;
    for (let i = 0; i < 5; i += 1) {
      const login = await passwordLogin(PLATFORM, email);
      last = await call('POST', PLATFORM.mfa, {
        body: {
          challenge: String(login.body.challenge),
          recoveryCode: 'AAAAA-AAAAA',
        },
      });
    }
    expect(last?.body.code).toBe('LOCKED');
    expect((await passwordLogin(PLATFORM, email)).body.code).toBe('LOCKED');
    await rewindAdmin(email);
  });

  it('lets an owner reset another admin (audited) who then enrols again; not oneself', async () => {
    const owner = await newAdmin('resetter');
    const first = await passwordLogin(PLATFORM, owner.email);
    const enrol = await call('POST', `${PLATFORM.mfa}/setup`, {
      body: { challenge: String(first.body.challenge) },
    });
    const ownerSecret = String(enrol.body.secret);
    const entered = await call('POST', `${PLATFORM.mfa}/enable`, {
      body: {
        challenge: String(first.body.challenge),
        code: nextCode(ownerSecret, 0),
      },
    });
    const session = sessionFrom(entered, 'ac_platform');

    const self = await call(
      'POST',
      `/api/v1/platform/admins/${owner.id}/mfa/reset`,
      { session },
    );
    expect(self.status).toBe(409);
    const reset = await call(
      'POST',
      `/api/v1/platform/admins/${adminId}/mfa/reset`,
      { session },
    );
    expect(reset.status).toBe(204);
    const row = await db.platformAdmin.findUniqueOrThrow({ where: { email } });
    expect(row.totpEnabledAt).toBeNull();
    const audit = await db.platformAuditEvent.findMany({
      where: { action: 'admin.mfa_reset', entityId: adminId },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorAdminId).toBe(owner.id);
    expect(
      (await passwordLogin(PLATFORM, email)).body.mfaEnrollmentRequired,
    ).toBe(true);
  });

  it('lets a support admin manage their own second factor', async () => {
    const support = await newAdmin('support', 'PLATFORM_SUPPORT');
    const login = await passwordLogin(PLATFORM, support.email);
    const challenge = String(login.body.challenge);
    const setup = await call('POST', `${PLATFORM.mfa}/setup`, {
      body: { challenge },
    });
    const done = await call('POST', `${PLATFORM.mfa}/enable`, {
      body: { challenge, code: nextCode(String(setup.body.secret), 0) },
    });
    const session = sessionFrom(done, 'ac_platform');
    const status = await call('GET', PLATFORM.prefix, { session });
    expect(status.body.enabled).toBe(true);
    const regenerate = await call('POST', `${PLATFORM.prefix}/recovery-codes`, {
      session,
      body: { code: nextCode(String(setup.body.secret), 1) },
    });
    expect(regenerate.status).toBe(200);
  });
});

describe('without the keyring', () => {
  const noKey = new MfaService(db as unknown as PrismaService);

  it('refuses enrolment and never stores a secret', async () => {
    const { operatorId } = await newOperator('nokey');
    await expect(
      noKey.setup({ kind: 'OPERATOR', tenantId, operatorId }),
    ).rejects.toMatchObject({ code: 'MFA_NOT_AVAILABLE' });
    await expect(
      noKey.setup({ kind: 'OPERATOR', tenantId, operatorId }),
    ).rejects.toBeInstanceOf(MfaError);
    const row = await db.operatorCredential.findUniqueOrThrow({
      where: { operatorId },
    });
    expect(row.totpCiphertext).toBeNull();
  });

  it('refuses sign-in where a second factor is owed, for both principals', async () => {
    const { email: platformEmail } = await newAdmin('nokey-admin');
    const platform = new PlatformSessionService(
      db as unknown as PrismaService,
      undefined,
      noKey,
    );
    expect(await platform.login(platformEmail, PASSWORD)).toEqual({
      ok: false,
      code: 'MFA_NOT_AVAILABLE',
    });

    const { email, operatorId } = await newOperator('nokey-enrolled');
    await db.operatorCredential.update({
      where: { operatorId },
      data: {
        totpKeyId: 'k1',
        totpNonce: new Uint8Array(12),
        totpCiphertext: new Uint8Array(32),
        totpEnabledAt: new Date(),
      },
    });
    const tenantSessions = new SessionService(
      db as unknown as PrismaService,
      undefined,
      undefined,
      noKey,
    );
    expect(await tenantSessions.login(email, PASSWORD)).toEqual({
      ok: false,
      code: 'MFA_NOT_AVAILABLE',
    });
  });
});
