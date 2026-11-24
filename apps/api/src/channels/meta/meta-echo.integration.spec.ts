import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../../config/environment.js';
import { OperatorIdleReturnService } from '../../handover/operator-idle-return.service.js';
import type { PrivilegedDatabase } from '../../persistence/privileged-database.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../../persistence/testing/test-clients.js';
import { InstagramWebhookService } from '../instagram/instagram-webhook.service.js';
import { META_ECHO_SETTLE_MS, MetaEchoService } from './meta-echo.service.js';
import type { MetaSentLedger } from './meta-sent-ledger.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Meta echo integration tests require agentcore_test');
}
const db = ownerClient();
const app = appClient();
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const ours = new Set<string>();
const echoes = new MetaEchoService(
  app as unknown as PrismaService,
  {
    has: (mid: string) => Promise.resolve(ours.has(mid)),
  } as unknown as MetaSentLedger,
);

type EchoPayload = {
  channelAccountId: string;
  customerId: string;
  mid: string;
  text: string;
};

async function fixture(state: 'BOT_ACTIVE' | 'WAITING_OPERATOR'): Promise<{
  tenantId: string;
  conversationId: string;
  accountExternalId: string;
  payload: (mid: string, text?: string) => EchoPayload;
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `echo-${suffix}`,
      name: 'Echo fixture',
      timezone: 'Asia/Tashkent',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn'],
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'instagram',
      externalAccountId: `9${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: '777',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: '777',
      state,
    },
  });
  await db.message.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      channelAccountId: account.id,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      text: 'Narxi qancha?',
      sequence: 1,
      providerChatId: '777',
      providerMessageId: `in-${suffix}`,
    },
  });
  const payload = (mid: string, text = 'Ertaga keling'): EchoPayload => ({
    channelAccountId: account.id,
    customerId: '777',
    mid,
    text,
  });
  return {
    tenantId: tenant.id,
    conversationId: conversation.id,
    accountExternalId: account.externalAccountId,
    payload,
  };
}

describe('an echo from the Instagram or Messenger app (ADR 088)', () => {
  it('pauses the bot and keeps the person reply; the idle return gives it back', async () => {
    const f = await fixture('BOT_ACTIVE');
    expect(await echoes.process(f.tenantId, f.payload('app-1'))).toBe('paused');

    const conversation = await db.conversation.findFirstOrThrow({
      where: { id: f.conversationId },
      select: { state: true, assignedOperatorId: true },
    });
    expect(conversation).toEqual({
      state: 'OPERATOR_ACTIVE',
      assignedOperatorId: null,
    });
    const reply = await db.message.findFirstOrThrow({
      where: { conversationId: f.conversationId, sequence: 2 },
    });
    expect(reply).toMatchObject({
      authorType: 'OPERATOR',
      direction: 'OUTBOUND',
      text: 'Ertaga keling',
      providerMessageId: 'app-1',
      deliveryState: 'SENT',
    });
    expect(
      await db.handover.findFirstOrThrow({
        where: { conversationId: f.conversationId },
        select: { status: true, reasonCode: true },
      }),
    ).toEqual({ status: 'TAKEN', reasonCode: 'OWNER_APP_REPLY' });
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: f.tenantId,
          action: 'conversation.app_reply_paused',
        },
      }),
    ).toBe(1);

    // The same echo again (Meta retry): stored once, no second pause.
    expect(await echoes.process(f.tenantId, f.payload('app-1'))).toBe('ours');
    expect(
      await db.message.count({ where: { conversationId: f.conversationId } }),
    ).toBe(2);

    // The customer writes and nobody answers: the bot is back.
    await db.message.create({
      data: {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        channelAccountId: reply.channelAccountId,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        text: 'Rahmat, yana savol bor',
        sequence: 3,
        providerChatId: '777',
      },
    });
    const idle = tenantScoped(
      new OperatorIdleReturnService(
        app as unknown as PrismaService,
        {
          get: () => 2,
        } as unknown as ConfigService<AppEnvironment, true>,
        { db } as PrivilegedDatabase,
      ),
    );
    const later = new Date(Date.now() + 5 * 60_000);
    expect(await idle.scan(later, 2, { tenantId: f.tenantId })).toBe(1);
    expect(
      (
        await db.conversation.findFirstOrThrow({
          where: { id: f.conversationId },
        })
      ).state,
    ).toBe('BOT_ACTIVE');
  });

  it('takes a waiting handover without an operator', async () => {
    const f = await fixture('WAITING_OPERATOR');
    await db.handover.create({
      data: {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reasonCode: 'CUSTOMER_ASKED',
        summary: {},
      },
    });
    expect(await echoes.process(f.tenantId, f.payload('app-2', ''))).toBe(
      'paused',
    );
    expect(
      await db.handover.findMany({
        where: { conversationId: f.conversationId },
        select: { status: true, reasonCode: true },
      }),
    ).toEqual([{ status: 'TAKEN', reasonCode: 'CUSTOMER_ASKED' }]);
  });

  it('ignores our own sends: by the ledger and by a stored message id', async () => {
    const f = await fixture('BOT_ACTIVE');
    ours.add('bot-1');
    expect(await echoes.process(f.tenantId, f.payload('bot-1'))).toBe('ours');
    await db.message.create({
      data: {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        channelAccountId: f.payload('x').channelAccountId,
        authorType: 'BOT',
        direction: 'OUTBOUND',
        text: 'Narx: ...',
        sequence: 2,
        providerChatId: '777',
        providerMessageId: 'bot-2',
      },
    });
    expect(await echoes.process(f.tenantId, f.payload('bot-2'))).toBe('ours');
    expect(
      (
        await db.conversation.findFirstOrThrow({
          where: { id: f.conversationId },
        })
      ).state,
    ).toBe('BOT_ACTIVE');
  });

  it('does nothing for a customer with no conversation', async () => {
    const f = await fixture('BOT_ACTIVE');
    expect(
      await echoes.process(f.tenantId, {
        ...f.payload('app-3'),
        customerId: '888',
      }),
    ).toBe('no_conversation');
  });

  it('the webhook queues an echo for later, once (Meta retries)', async () => {
    const f = await fixture('BOT_ACTIVE');
    const webhook = new InstagramWebhookService(
      app as unknown as PrismaService,
      { db } as PrivilegedDatabase,
    );
    const event = {
      kind: 'echo' as const,
      messageId: 'app-4',
      accountId: f.accountExternalId,
      customerId: '777',
      text: 'Salom',
      receivedAt: new Date(),
    };
    const before = Date.now();
    expect(await webhook.acceptEcho(event, 'instagram')).toBe('accepted');
    expect(await webhook.acceptEcho(event, 'instagram')).toBe('duplicate');
    const row = await db.outboxEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, type: 'meta.echo' },
    });
    expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(
      before + META_ECHO_SETTLE_MS,
    );
    expect(row.payload).toMatchObject({ mid: 'app-4', customerId: '777' });
  });
});
