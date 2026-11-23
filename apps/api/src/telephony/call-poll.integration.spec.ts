/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import { appClient, ownerClient } from '../persistence/testing/test-clients.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import { CallPollScan } from './call-poll.scan.js';
import type { OnlinePbxTransport } from './onlinepbx-client.js';
import { sealTelephonyApiKey } from './telephony-key.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Call poll tests require agentcore_test');
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const cipher = new SecretCipher(
  createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
);
const NOW = new Date('2026-11-23T10:00:00Z');
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A fake PBX serving `calls` for any search; counts auth requests. */
function fakePbx(calls: object[], options: { rejectKey?: boolean } = {}) {
  const sent: Array<{ path: string; form: Record<string, string> }> = [];
  const transport: OnlinePbxTransport = async (url, form) => {
    const path = url.split('/').slice(4).join('/');
    sent.push({ path, form: { ...form } });
    if (path === 'auth.json')
      return options.rejectKey
        ? { status: 200, body: { status: '0' } }
        : {
            status: 200,
            body: { status: '1', data: { key_id: 'i', key: 'k' } },
          };
    return { status: 200, body: { status: '1', data: calls } };
  };
  return { sent, transport };
}

async function connected(minutes: number | undefined) {
  const t = await db.tenant.create({
    data: {
      slug: `poll-${randomUUID()}`,
      name: 'Poll fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  if (minutes !== undefined) {
    const plan = await db.subscriptionPlan.create({
      data: {
        code: `poll-${randomBytes(6).toString('hex')}`,
        name: 'Premium fixture',
        priceMinor: 0n,
        periodDays: 30,
        limits: { callAnalysisMinutes: minutes },
      },
    });
    await db.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planId: plan.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
      },
    });
  }
  const account = await db.telephonyAccount.create({
    data: {
      tenantId: t.id,
      provider: 'ONLINEPBX',
      domain: 'example.onpbx.ru',
      polledUntil: new Date('2026-11-23T09:55:00Z'),
      ...sealTelephonyApiKey(cipher, t.id, 'ONLINEPBX', 'api-key'),
    },
  });
  return { tenantId: t.id, accountId: account.id };
}

const call = (uuid: string, talk: number, direction = 'inbound') => ({
  uuid,
  caller_id_number: direction === 'outbound' ? '101' : '998901234567',
  destination_number: direction === 'outbound' ? '998907654321' : '101',
  start_stamp: sec('2026-11-23T09:56:00Z'),
  end_stamp: sec('2026-11-23T09:56:00Z') + talk + 5,
  user_talk_time: talk,
  accountcode: direction,
});

const poll = (
  scan: CallPollScan,
  t: { tenantId: string; accountId: string },
  now = NOW,
) =>
  runWithTenant(t.tenantId, () => scan.pollOne(t.tenantId, t.accountId, now));

describe('reading OnlinePBX calls (ADR 085 step 2)', () => {
  it('stores answered calls once, from the cursor minus the overlap, with the customer side as phone', async () => {
    const t = await connected(300);
    const pbx = fakePbx([call('in-1', 75), call('out-1', 30, 'outbound')]);
    const scan = new CallPollScan(prisma, undefined, cipher, pbx.transport);

    expect(await poll(scan, t)).toBe(2);
    expect(pbx.sent[1]?.form).toEqual({
      end_stamp_from: String(sec('2026-11-23T09:53:00Z')),
      end_stamp_to: String(sec('2026-11-23T10:00:00Z')),
      user_talk_time_from: '1',
    });
    const rows = await db.callRecording.findMany({
      where: { tenantId: t.tenantId },
      orderBy: { providerCallId: 'asc' },
    });
    expect(
      rows.map((r) => [
        r.providerCallId,
        r.customerPhone,
        r.internalNumber,
        r.status,
      ]),
    ).toEqual([
      ['in-1', '998901234567', '101', 'PENDING'],
      ['out-1', '998907654321', '101', 'PENDING'],
    ]);

    // The next run overlaps the last window: nothing new, and the session is reused.
    expect(await poll(scan, t, new Date('2026-11-23T10:05:00Z'))).toBe(0);
    expect(pbx.sent.filter((s) => s.path === 'auth.json')).toHaveLength(1);
    const account = await db.telephonyAccount.findUniqueOrThrow({
      where: { id: t.accountId },
    });
    expect(account.polledUntil).toEqual(new Date('2026-11-23T10:05:00Z'));
  });

  it('stores calls past the monthly minutes as SKIPPED_LIMIT', async () => {
    const t = await connected(2);
    const pbx = fakePbx([call('a', 90), call('b', 30)]);
    await poll(new CallPollScan(prisma, undefined, cipher, pbx.transport), t);
    const rows = await db.callRecording.findMany({
      where: { tenantId: t.tenantId },
      orderBy: { providerCallId: 'asc' },
    });
    expect(rows.map((r) => [r.providerCallId, r.status])).toEqual([
      // Oldest first: b (1 min) ended before a (2 min) and fits; a does not.
      ['a', 'SKIPPED_LIMIT'],
      ['b', 'PENDING'],
    ]);
  });

  it('does not call the PBX without call minutes on the plan', async () => {
    const t = await connected(undefined);
    const pbx = fakePbx([call('a', 60)]);
    expect(
      await poll(new CallPollScan(prisma, undefined, cipher, pbx.transport), t),
    ).toBe(0);
    expect(pbx.sent).toEqual([]);
  });

  it('records a refused key as the account error and keeps the cursor', async () => {
    const t = await connected(300);
    const pbx = fakePbx([], { rejectKey: true });
    expect(
      await poll(new CallPollScan(prisma, undefined, cipher, pbx.transport), t),
    ).toBe(0);
    const account = await db.telephonyAccount.findUniqueOrThrow({
      where: { id: t.accountId },
    });
    expect(account).toMatchObject({
      lastError: 'REJECTED',
      polledUntil: new Date('2026-11-23T09:55:00Z'),
    });
  });
});
