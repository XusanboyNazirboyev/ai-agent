import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { TelegramWebhookService } from '../channels/telegram/telegram-webhook.service.js';
import { normalizeTelegramUpdate } from '../channels/telegram/telegram-normalizer.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  LEAD_BACKFILL_ACTION,
  LeadBackfillScan,
} from './lead-backfill.scan.js';
import { LeadService } from './lead.service.js';

// Owner decision 2026-11-17: every customer who writes is a lead, in any
// assistant mode; opening the bot (/start) is not writing.

loadEnv({ path: resolve(process.cwd(), '../../.env') });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Lead integration tests require agentcore_test');

// RLS plan S8b: fixtures and checks on the owner (`prisma`); the code under
// test on the app role (`db`): the update accepted under its account's
// tenant, the backfill run per tenant as its scan runs it.
const prisma = ownerClient();
const app = appClient();
const db = app as unknown as PrismaService;

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), app.$disconnect()]);
});

function config(
  values: Record<string, unknown>,
): ConfigService<AppEnvironment, true> {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<AppEnvironment, true>;
}

async function tenant(): Promise<{ tenantId: string; accountId: string }> {
  const suffix = randomUUID();
  const created = await prisma.tenant.create({
    data: {
      slug: `customer-lead-${suffix}`,
      name: 'Customer lead fixture',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn', 'ru', 'en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await prisma.channelAccount.create({
    data: {
      tenantId: created.id,
      channelType: 'telegram',
      externalAccountId: `customer-lead-${suffix}`,
      status: 'ACTIVE',
      agentMode: 'OFF',
    },
  });
  return { tenantId: created.id, accountId: account.id };
}

let updateId = Math.floor(Math.random() * 1e8);
function text(
  chatId: number,
  body: string,
): ReturnType<typeof normalizeTelegramUpdate> {
  updateId += 1;
  return normalizeTelegramUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: chatId, type: 'private' },
      from: { id: chatId },
      text: body,
    },
  });
}

async function conversationWith(
  tenantId: string,
  accountId: string,
  messages: ReadonlyArray<{ text: string; type?: 'TEXT' | 'COMMENT' }>,
): Promise<string> {
  const suffix = randomUUID();
  const contact = await prisma.contact.create({
    data: { tenantId, channelAccountId: accountId, providerUserId: suffix },
  });
  const conversation = await prisma.conversation.create({
    data: {
      tenantId,
      channelAccountId: accountId,
      contactId: contact.id,
      providerChatId: suffix,
    },
  });
  let sequence = 0;
  for (const message of messages) {
    sequence += 1;
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        channelAccountId: accountId,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        type: message.type ?? 'TEXT',
        text: message.text,
        sequence,
        providerChatId: suffix,
        providerMessageId: `${suffix}-${sequence}`,
      },
    });
  }
  return conversation.id;
}

const leadOf = (
  tenantId: string,
  conversationId: string,
): Promise<{ score: string; pipelineStageId: string | null } | null> =>
  prisma.lead.findFirst({
    where: { tenantId, conversationId },
    select: { score: true, pipelineStageId: true },
  });

describe('every customer who writes is a lead', () => {
  it('a Telegram message makes a cold lead in the first stage even with the assistant off; /start does not', async () => {
    const { tenantId, accountId } = await tenant();
    const webhook = new TelegramWebhookService(
      db,
      config({ TELEGRAM_RATE_LIMIT_PER_MINUTE: 120 }),
    );
    // As the webhook route: the update runs under its account's tenant.
    const service = {
      accept: (
        ...args: Parameters<TelegramWebhookService['accept']>
      ): ReturnType<TelegramWebhookService['accept']> =>
        runWithTenant(tenantId, () => webhook.accept(...args)),
    };
    const chat = Math.floor(Math.random() * 1e9) + 1_000;
    const opened = text(
      chat,
      '/start AaGqGP0HdJiHvSuo47tXyZ0123456789abcdefghijkl',
    );
    if (opened.kind !== 'text') throw new Error('expected text');
    expect(await service.accept(accountId, opened)).toBe('accepted');
    expect(await prisma.lead.count({ where: { tenantId } })).toBe(0);

    const wrote = text(chat, 'Salom, kurslar haqida bilmoqchiman');
    if (wrote.kind !== 'text') throw new Error('expected text');
    expect(await service.accept(accountId, wrote)).toBe('accepted');
    const leads = await prisma.lead.findMany({
      where: { tenantId },
      select: { score: true, pipelineId: true, pipelineStageId: true },
    });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.score).toBe('COLD');
    // In an open stage of the default funnel (AI staging may move it on).
    const stage = await prisma.leadStage.findFirst({
      where: { tenantId, id: leads[0]!.pipelineStageId ?? '' },
      select: { kind: true, pipelineId: true },
    });
    expect(stage).toEqual({ kind: 'OPEN', pipelineId: leads[0]!.pipelineId });

    // A second message keeps the one lead.
    const again = text(chat, 'IELTS bormi?');
    if (again.kind !== 'text') throw new Error('expected text');
    await service.accept(accountId, again);
    expect(await prisma.lead.count({ where: { tenantId } })).toBe(1);
  });

  it('the one-time backfill gives older conversations a lead, skips /start, comments and deleted leads, then stops', async () => {
    const { tenantId, accountId } = await tenant();
    const wrote = await conversationWith(tenantId, accountId, [
      { text: '/start' },
      { text: 'kurs kerak' },
    ]);
    const openedOnly = await conversationWith(tenantId, accountId, [
      { text: '/start AaGqGP0HdJiHvSuo47tXyZ0123456789abcdefghijkl' },
    ]);
    const commentOnly = await conversationWith(tenantId, accountId, [
      { text: 'zo‘r!', type: 'COMMENT' },
    ]);
    const deleted = await conversationWith(tenantId, accountId, [
      { text: 'narxi qancha?' },
    ]);
    await prisma.auditEvent.create({
      data: {
        tenantId,
        actorType: 'OPERATOR',
        action: 'lead.deleted',
        entityType: 'lead',
        entityId: randomUUID(),
        safeInputSummary: { conversationId: deleted },
      },
    });

    const scan = tenantScoped(new LeadBackfillScan(db, new LeadService(db)), {
      tenantArg: 0,
    });
    expect(await scan.backfillTenant(tenantId)).toBe(1);
    expect(await leadOf(tenantId, wrote)).toMatchObject({ score: 'COLD' });
    expect(await leadOf(tenantId, openedOnly)).toBeNull();
    expect(await leadOf(tenantId, commentOnly)).toBeNull();
    expect(await leadOf(tenantId, deleted)).toBeNull();
    expect(
      await prisma.auditEvent.count({
        where: { tenantId, action: LEAD_BACKFILL_ACTION },
      }),
    ).toBe(1);
    // Nothing left: a second run creates nothing.
    expect(await scan.backfillTenant(tenantId)).toBe(0);
  });
});
