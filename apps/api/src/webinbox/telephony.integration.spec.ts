/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import type { OnlinePbxTransport } from '../telephony/onlinepbx-client.js';
import { openTelephonyApiKey } from '../telephony/telephony-key.js';
import { TelephonyController } from './telephony.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Telephony API tests require agentcore_test');
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const cipher = new SecretCipher(
  createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
);

/** A fake PBX: accepts only `goodKey`, records what was sent. */
function fakePbx(goodKey: string) {
  const sent: string[] = [];
  const transport: OnlinePbxTransport = async (url, form) => {
    sent.push(url);
    return form.auth_key === goodKey
      ? {
          status: 200,
          body: { status: '1', data: { key_id: 'kid', key: 'k' } },
        }
      : { status: 200, body: { status: '0', comment: 'wrong key' } };
  };
  return { sent, transport };
}

async function tenant(
  options: { role?: 'OWNER' | 'ADMIN' | 'OPERATOR'; minutes?: number } = {},
) {
  const role = options.role ?? 'ADMIN';
  const t = await db.tenant.create({
    data: {
      slug: `pbx-${randomUUID()}`,
      name: 'PBX fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  if (options.minutes !== undefined) {
    const plan = await db.subscriptionPlan.create({
      data: {
        code: `pbx-${randomBytes(6).toString('hex')}`,
        name: 'Premium fixture',
        priceMinor: 0n,
        periodDays: 30,
        limits: { callAnalysisMinutes: options.minutes },
      },
    });
    await db.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planId: plan.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
  }
  const operator = await db.operator.create({
    data: { tenantId: t.id, displayName: 'Admin', role },
  });
  return {
    tenantId: t.id,
    request: {
      principal: {
        tenantId: t.id,
        operatorId: operator.id,
        role,
        sessionId: randomUUID(),
      },
    } as never,
  };
}

const controller = (transport: OnlinePbxTransport) =>
  tenantScoped(new TelephonyController(prisma, cipher, transport));

describe('connecting OnlinePBX for call analysis (ADR 085)', () => {
  it('checks the key, stores it sealed and never returns or audits it', async () => {
    const key = `pbx-${randomBytes(8).toString('hex')}`;
    const pbx = fakePbx(key);
    const t = await tenant({ minutes: 300 });
    const status = await controller(pbx.transport).connect(t.request, {
      domain: ' Example.onpbx.ru ',
      apiKey: key,
    });
    expect(status).toMatchObject({
      minutesLimit: 300,
      account: { domain: 'example.onpbx.ru', enabled: true, connected: true },
    });
    expect(pbx.sent).toEqual([
      'https://api2.onlinepbx.ru/example.onpbx.ru/auth.json',
    ]);
    const row = await db.telephonyAccount.findFirstOrThrow({
      where: { tenantId: t.tenantId },
    });
    expect(Buffer.from(row.apiKeyCipher!).toString('utf8')).not.toContain(key);
    expect(openTelephonyApiKey(cipher, row)).toBe(key);
    const audits = await db.auditEvent.findMany({
      where: { tenantId: t.tenantId },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'telephony.onlinepbx_connected',
    ]);
    expect(JSON.stringify([status, audits])).not.toContain(key);
  });

  it('refuses without call minutes on the plan and calls no PBX', async () => {
    const pbx = fakePbx('k');
    const t = await tenant();
    await expect(
      controller(pbx.transport).connect(t.request, {
        domain: 'example.onpbx.ru',
        apiKey: 'k',
      }),
    ).rejects.toMatchObject({ response: { code: 'PLAN_REQUIRED' } });
    expect(pbx.sent).toEqual([]);
  });

  it('refuses a key the PBX rejects and stores nothing', async () => {
    const t = await tenant({ minutes: 300 });
    await expect(
      controller(fakePbx('right').transport).connect(t.request, {
        domain: 'example.onpbx.ru',
        apiKey: 'wrong',
      }),
    ).rejects.toMatchObject({ response: { code: 'PBX_REJECTED' } });
    expect(
      await db.telephonyAccount.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
  });

  it('is for owners and admins only', async () => {
    const t = await tenant({ role: 'OPERATOR', minutes: 300 });
    await expect(
      controller(fakePbx('k').transport).status(t.request),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('disconnect deletes the key and keeps the calls; another domain restarts the cursor', async () => {
    const pbx = fakePbx('k');
    const t = await tenant({ minutes: 300 });
    const api = controller(pbx.transport);
    await api.connect(t.request, { domain: 'one.onpbx.ru', apiKey: 'k' });
    const row = await db.telephonyAccount.update({
      where: {
        tenantId_provider: { tenantId: t.tenantId, provider: 'ONLINEPBX' },
      },
      data: { polledUntil: new Date() },
    });
    await db.callRecording.create({
      data: {
        tenantId: t.tenantId,
        telephonyAccountId: row.id,
        providerCallId: 'c1',
        direction: 'inbound',
        startedAt: new Date(),
        endedAt: new Date(),
        talkSeconds: 10,
      },
    });
    await api.disconnect(t.request);
    const after = await db.telephonyAccount.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after).toMatchObject({
      enabled: false,
      apiKeyKeyId: null,
      apiKeyNonce: null,
      apiKeyCipher: null,
    });
    expect(
      await db.callRecording.count({ where: { tenantId: t.tenantId } }),
    ).toBe(1);

    await api.connect(t.request, { domain: 'two.onpbx.ru', apiKey: 'k' });
    const moved = await db.telephonyAccount.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(moved).toMatchObject({
      domain: 'two.onpbx.ru',
      enabled: true,
      polledUntil: null,
    });
  });
});
