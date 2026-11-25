import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../../config/environment.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { PrivilegedDatabase } from '../../persistence/privileged-database.js';
import {
  appClient,
  ownerClient,
} from '../../persistence/testing/test-clients.js';
import { MetaEchoService } from '../meta/meta-echo.service.js';
import type { MetaSentLedger } from '../meta/meta-sent-ledger.js';
import {
  businessAccountKey,
  businessLinkKey,
  createBusinessLinkPayload,
} from './telegram-business.js';
import { TelegramBusinessService } from './telegram-business.service.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
// Fixtures on the owner; the service on the app role, routing on the owner
// (the privileged pool), as in production.
const prisma = ownerClient();
const app = appClient();
afterAll(async () => {
  await Promise.all([prisma.$disconnect(), app.$disconnect()]);
});

const MASTER = randomBytes(32).toString('base64');
const config = {
  get: (key: string) =>
    ({ SECRETS_MASTER_KEY: MASTER, TELEGRAM_RATE_LIMIT_PER_MINUTE: 60 })[
      key
    ] as never,
} as unknown as ConfigService<AppEnvironment, true>;
const db = app as unknown as PrismaService;
const service = new TelegramBusinessService(
  db,
  config,
  new TelegramWebhookService(db, config),
  new MetaEchoService(db, {
    has: () => Promise.resolve(false),
  } as unknown as MetaSentLedger),
  { db: prisma } as unknown as PrivilegedDatabase,
);

async function tenant(): Promise<string> {
  const row = await prisma.tenant.create({
    data: {
      slug: `tg-business-${randomUUID()}`,
      name: 'Business fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey: 'integration-test',
      packVersion: '1',
    },
  });
  return row.id;
}

let updateId = 1_000;
const ownerId = (): number => 7_000_000_000 + Math.floor(Math.random() * 1e8);

function start(
  tenantId: string,
  fromId: number,
): { update_id: number; message: Record<string, unknown> & { text: string } } {
  const { payload } = createBusinessLinkPayload(
    businessLinkKey(MASTER),
    tenantId,
    new Date(),
  );
  return {
    update_id: updateId++,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: fromId, type: 'private' },
      from: { id: fromId, is_bot: false, language_code: 'en' },
      text: `/start ${payload}`,
    },
  };
}

function connection(
  fromId: number,
  connectionId: string,
  canReply = true,
): Record<string, unknown> {
  return {
    update_id: updateId++,
    business_connection: {
      id: connectionId,
      user: { id: fromId, language_code: 'en' },
      user_chat_id: fromId,
      date: 1,
      is_enabled: true,
      rights: { can_reply: canReply },
    },
  };
}

function businessMessage(
  connectionId: string,
  fromId: number,
  chatId: number,
  text: string,
  extra: object = {},
): Record<string, unknown> {
  return {
    update_id: updateId++,
    business_message: {
      message_id: updateId,
      business_connection_id: connectionId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Ali' },
      from: { id: fromId, is_bot: false, first_name: 'Ali' },
      text,
      ...extra,
    },
  };
}

async function linked(): Promise<{
  tenantId: string;
  owner: number;
  connectionId: string;
  accountId: string;
}> {
  const tenantId = await tenant();
  const owner = ownerId();
  const connectionId = `bc-${randomUUID()}`;
  await service.handleUpdate(start(tenantId, owner));
  await service.handleUpdate(connection(owner, connectionId));
  const account = await prisma.channelAccount.findUniqueOrThrow({
    where: {
      channelType_externalAccountId: {
        channelType: 'telegram',
        externalAccountId: businessAccountKey(String(owner)),
      },
    },
  });
  return { tenantId, owner, connectionId, accountId: account.id };
}

describe('Telegram Business through the platform bot (ADR 092)', () => {
  it('links with a signed code, connects, and takes a customer message into the ordinary intake', async () => {
    const tenantId = await tenant();
    const owner = ownerId();
    const linkedReply = await service.handleUpdate(start(tenantId, owner));
    expect(linkedReply.handled).toBe(true);
    expect(linkedReply.reply?.text).toMatch(/linked/u);
    const account = await prisma.channelAccount.findUniqueOrThrow({
      where: {
        channelType_externalAccountId: {
          channelType: 'telegram',
          externalAccountId: businessAccountKey(String(owner)),
        },
      },
    });
    expect(account).toMatchObject({ tenantId, status: 'DISABLED' });

    const connectionId = `bc-${randomUUID()}`;
    const connected = await service.handleUpdate(
      connection(owner, connectionId),
    );
    expect(connected.reply).toMatchObject({ chatId: String(owner) });
    expect(
      await prisma.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
      }),
    ).toMatchObject({ status: 'ACTIVE', businessConnectionId: connectionId });

    await service.handleUpdate(
      businessMessage(connectionId, 555_001, 555_001, 'How much is it?'),
    );
    const events = await prisma.inboundEvent.findMany({
      where: { tenantId, channelAccountId: account.id },
    });
    expect(events).toHaveLength(1);
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { tenantId, channelAccountId: account.id },
    });
    expect(conversation.providerChatId).toBe('555001');
    expect(
      await prisma.auditEvent.count({
        where: {
          tenantId,
          action: {
            in: [
              'channel.telegram_business_linked',
              'channel.telegram_business_connection',
            ],
          },
        },
      }),
    ).toBe(2);
  });

  it('the owner typing in the chat makes the bot step back; bot and away messages do not', async () => {
    const { tenantId, owner, connectionId, accountId } = await linked();
    await service.handleUpdate(
      businessMessage(connectionId, 555_002, 555_002, 'Hello'),
    );
    await service.handleUpdate(
      businessMessage(connectionId, owner, 555_002, 'auto', {
        sender_business_bot: { id: 1, is_bot: true, first_name: 'bot' },
      }),
    );
    await service.handleUpdate(
      businessMessage(connectionId, owner, 555_002, 'away', {
        is_from_offline: true,
      }),
    );
    const before = await prisma.conversation.findFirstOrThrow({
      where: { tenantId, channelAccountId: accountId },
    });
    expect(before.state).toBe('BOT_ACTIVE');
    await service.handleUpdate(
      businessMessage(connectionId, owner, 555_002, 'I will answer myself'),
    );
    const after = await prisma.conversation.findFirstOrThrow({
      where: { id: before.id },
    });
    expect(after.state).toBe('OPERATOR_ACTIVE');
    const operatorMessages = await prisma.message.findMany({
      where: { tenantId, conversationId: before.id, authorType: 'OPERATOR' },
      select: { text: true },
    });
    expect(operatorMessages).toEqual([{ text: 'I will answer myself' }]);
    // Owner messages are never customer intake.
    expect(
      await prisma.inboundEvent.count({
        where: { tenantId, channelAccountId: accountId },
      }),
    ).toBe(1);
  });

  it('refuses a second tenant for the same Telegram user, a bad code and an unlinked connection', async () => {
    const { owner } = await linked();
    const other = await tenant();
    const refused = await service.handleUpdate(start(other, owner));
    expect(refused.reply?.text).toMatch(/another business/u);
    const bad = start(other, ownerId());
    bad.message.text = `${bad.message.text.slice(0, -1)}${bad.message.text.endsWith('A') ? 'B' : 'A'}`;
    expect((await service.handleUpdate(bad)).reply?.text).toMatch(/expired/u);
    const stranger = await service.handleUpdate(
      connection(ownerId(), `bc-${randomUUID()}`),
    );
    expect(stranger).toEqual({ handled: true });
    expect(
      await prisma.channelAccount.count({ where: { tenantId: other } }),
    ).toBe(0);
  });

  it('stays off without can_reply and when the plan has no free channel; messages are then ignored', async () => {
    const tenantId = await tenant();
    await prisma.channelAccount.create({
      data: {
        tenantId,
        channelType: 'telegram',
        externalAccountId: `telegram-${randomUUID()}`,
        status: 'ACTIVE',
      },
    });
    const owner = ownerId();
    const connectionId = `bc-${randomUUID()}`;
    await service.handleUpdate(start(tenantId, owner));
    const limited = await service.handleUpdate(connection(owner, connectionId));
    expect(limited.reply?.text).toMatch(/channel limit/u);
    const quiet = await service.handleUpdate(
      connection(owner, connectionId, false),
    );
    expect(quiet).toEqual({ handled: true });
    await service.handleUpdate(
      businessMessage(connectionId, 555_003, 555_003, 'Hi'),
    );
    const account = await prisma.channelAccount.findFirstOrThrow({
      where: { businessConnectionId: connectionId },
    });
    expect(account.status).toBe('DISABLED');
    expect(
      await prisma.inboundEvent.count({
        where: { tenantId, channelAccountId: account.id },
      }),
    ).toBe(0);
  });

  it('leaves non-business updates to signup', async () => {
    // A 43-character signup token that happens to start with "biz".
    expect(
      await service.handleUpdate({
        update_id: updateId++,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 1, type: 'private' },
          from: { id: 1, is_bot: false },
          text: `/start biz${'a'.repeat(40)}`,
        },
      }),
    ).toEqual({ handled: false });
    expect(
      await service.handleUpdate({
        update_id: updateId++,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 1, type: 'private' },
          from: { id: 1, is_bot: false },
          text: '/start abc',
        },
      }),
    ).toEqual({ handled: false });
  });
});
