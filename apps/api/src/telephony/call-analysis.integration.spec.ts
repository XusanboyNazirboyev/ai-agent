/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentConversationService } from '../agent/agent-conversation.service.js';
import type { downloadPublicMedia } from '../channels/voice/media-download.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import type { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { appClient, ownerClient } from '../persistence/testing/test-clients.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import { CallAnalysisScan, MAX_CALL_ATTEMPTS } from './call-analysis.scan.js';
import type { OnlinePbxTransport } from './onlinepbx-client.js';
import type { CallTranscriber } from './ovozai-call-transcriber.js';
import { sealTelephonyApiKey } from './telephony-key.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Call analysis tests require agentcore_test');
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
const privileged = { db } as unknown as PrivilegedDatabase;
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const cipher = new SecretCipher(
  createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
);
const NOW = new Date('2026-11-23T10:00:00Z');
const REC = 'https://api2.onlinepbx.ru/calls-records/download/x/rec.mp3';

const pbx: OnlinePbxTransport = async (url, form) =>
  url.endsWith('auth.json')
    ? { status: 200, body: { status: '1', data: { key_id: 'i', key: 'k' } } }
    : form.download === '1'
      ? { status: 200, body: { status: '1', data: REC } }
      : { status: 200, body: { status: '1', data: [] } };

const audio: typeof downloadPublicMedia = async (url) =>
  url === REC
    ? { ok: true, data: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg' }
    : { ok: false, code: 'BLOCKED' };

const heard: CallTranscriber = {
  transcribe: async () => ({
    ok: true,
    segments: [
      { start: 0, end: 2, text: 'Assalomu alaykum, tezda.' },
      { start: 2, end: 5, text: 'Kurs narxini bilmoqchi edim.' },
    ],
  }),
};

function agent(seen: Array<{ tenantId: string; purpose: string }> = []) {
  return {
    tenantStructured: async (
      tenantId: string,
      _turnKey: string,
      request: { purpose: string },
    ) => {
      seen.push({ tenantId, purpose: request.purpose });
      return {
        summary: 'Mijoz kurs narxini so‘radi.',
        nextStep: 'Menejer ertaga narxni yuboradi.',
        speakers: 'SC',
      };
    },
  } as unknown as AgentConversationService;
}

async function pendingCall(phone = '998901234567') {
  const t = await db.tenant.create({
    data: {
      slug: `calls-${randomUUID()}`,
      name: 'Call analysis fixture',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.telephonyAccount.create({
    data: {
      tenantId: t.id,
      provider: 'ONLINEPBX',
      domain: 'example.onpbx.ru',
      ...sealTelephonyApiKey(cipher, t.id, 'ONLINEPBX', 'api-key'),
    },
  });
  const row = await db.callRecording.create({
    data: {
      tenantId: t.id,
      telephonyAccountId: account.id,
      providerCallId: `c-${randomUUID()}`,
      direction: 'inbound',
      customerPhone: phone,
      internalNumber: '101',
      startedAt: new Date('2026-11-23T09:50:00Z'),
      endedAt: new Date('2026-11-23T09:51:00Z'),
      talkSeconds: 55,
    },
  });
  return { tenantId: t.id, callId: row.id };
}

async function contactWith(tenantId: string, phone: string) {
  const channel = await db.channelAccount.create({
    data: {
      tenantId,
      channelType: 'telegram',
      externalAccountId: `calls-${randomUUID()}`,
      status: 'ACTIVE',
    },
  });
  return db.contact.create({
    data: {
      tenantId,
      channelAccountId: channel.id,
      providerUserId: `u-${randomUUID()}`,
      phone,
    },
  });
}

const scanWith = (
  overrides: {
    agent?: AgentConversationService;
    transcriber?: CallTranscriber;
  } = {},
) =>
  new CallAnalysisScan(
    prisma,
    privileged,
    cipher,
    pbx,
    undefined,
    overrides.agent ?? agent(),
    overrides.transcriber ?? heard,
    audio,
  );

async function run(scan: CallAnalysisScan, tenantId: string, now = NOW) {
  const started = await scan.scanDue(now, tenantId);
  await scan.idle();
  return started;
}

describe('analysing a call (ADR 085 step 3a)', () => {
  it('downloads, transcribes, summarises with the tenant budget and matches the contact', async () => {
    const t = await pendingCall('998901234567');
    const contact = await contactWith(t.tenantId, '+998 90 123-45-67');
    const seen: Array<{ tenantId: string; purpose: string }> = [];

    expect(await run(scanWith({ agent: agent(seen) }), t.tenantId)).toBe(1);

    const row = await db.callRecording.findUniqueOrThrow({
      where: { id: t.callId },
    });
    expect(row.status).toBe('ANALYSED');
    expect(row.attempts).toBe(1);
    expect(row.summary).toBe('Mijoz kurs narxini so‘radi.');
    expect(row.nextStep).toBe('Menejer ertaga narxni yuboradi.');
    expect(row.contactId).toBe(contact.id);
    expect(row.analysedAt).not.toBeNull();
    expect(row.transcript).toEqual([
      { start: 0, end: 2, text: 'Assalomu alaykum, tezda.', speaker: 'staff' },
      {
        start: 2,
        end: 5,
        text: 'Kurs narxini bilmoqchi edim.',
        speaker: 'customer',
      },
    ]);
    expect(seen).toEqual([{ tenantId: t.tenantId, purpose: 'call_summary' }]);
    // Analysed calls are not picked again.
    expect(await run(scanWith(), t.tenantId)).toBe(0);
  });

  it('keeps a failing call PENDING with its code, waits out the lease, and fails it after the last attempt', async () => {
    const t = await pendingCall();
    const busy = scanWith({
      transcriber: { transcribe: async () => ({ ok: false, code: 'BUSY' }) },
    });

    expect(await run(busy, t.tenantId)).toBe(1);
    let row = await db.callRecording.findUniqueOrThrow({
      where: { id: t.callId },
    });
    expect([row.status, row.attempts, row.failureReason]).toEqual([
      'PENDING',
      1,
      'STT_BUSY',
    ]);
    // Inside the lease the call is left alone.
    expect(await run(busy, t.tenantId, new Date())).toBe(0);

    for (let attempt = 2; attempt <= MAX_CALL_ATTEMPTS; attempt += 1)
      expect(
        await run(busy, t.tenantId, new Date(Date.now() + 60 * 60_000)),
      ).toBe(1);
    row = await db.callRecording.findUniqueOrThrow({ where: { id: t.callId } });
    expect([row.status, row.attempts, row.failureReason]).toEqual([
      'FAILED',
      MAX_CALL_ATTEMPTS,
      'STT_BUSY',
    ]);
    expect(
      await run(busy, t.tenantId, new Date(Date.now() + 2 * 60 * 60_000)),
    ).toBe(0);
  });

  it('does nothing without the transcriber key', async () => {
    const t = await pendingCall();
    const scan = new CallAnalysisScan(
      prisma,
      privileged,
      cipher,
      pbx,
      undefined,
      agent(),
      null,
      audio,
    );
    expect(await run(scan, t.tenantId)).toBe(0);
  });
});
