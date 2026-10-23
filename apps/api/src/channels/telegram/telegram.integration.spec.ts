import type { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { AppEnvironment } from '../../config/environment.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { TelegramProcessor } from './telegram-processor.js';
import { TelegramQueueRuntime } from './telegram-queue.runtime.js';
import {
  TelegramAmbiguousSendError,
  TelegramApiError,
  type TelegramSender,
} from './telegram-sender.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';
import { normalizeTelegramUpdate } from './telegram-normalizer.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Telegram integration tests require agentcore_test');
}

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});

function config(
  values: Record<string, unknown>,
): ConfigService<AppEnvironment, true> {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<AppEnvironment, true>;
}

type TelegramFixture = {
  tenantId: string;
  channelAccountId: string;
  service: TelegramWebhookService;
};

async function fixtures(rateLimit = 120): Promise<TelegramFixture> {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: {
      slug: `telegram-${suffix}`,
      name: 'Telegram integration fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey: 'integration-test',
      packVersion: '1',
    },
  });
  const account = await prisma.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `telegram-${suffix}`,
      status: 'ACTIVE',
    },
  });
  return {
    tenantId: tenant.id,
    channelAccountId: account.id,
    service: new TelegramWebhookService(
      prisma as unknown as PrismaService,
      config({
        TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
        TELEGRAM_WEBHOOK_SECRET: 'integration-secret',
        TELEGRAM_RATE_LIMIT_PER_MINUTE: rateLimit,
      }),
    ),
  };
}

function update(input: {
  updateId: number;
  messageId: number;
  chatId: number;
  userId?: number;
  text: string;
}): ReturnType<typeof normalizeTelegramUpdate> {
  return normalizeTelegramUpdate({
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: input.chatId },
      from: { id: input.userId ?? 100 },
      text: input.text,
    },
  });
}

describe('Telegram persistence and processing integration', () => {
  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  it('durably accepts concurrent duplicate webhook deliveries only once', async () => {
    const fixture = await fixtures();
    const normalized = update({
      updateId: 1_001,
      messageId: 10,
      chatId: 700,
      text: 'hello',
    });
    if (normalized.kind !== 'text') throw new Error('Expected normalized text');
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        fixture.service.accept(fixture.channelAccountId, normalized),
      ),
    );
    expect(results.filter((result) => result === 'accepted')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(3);
    expect(
      await prisma.inboundEvent.count({
        where: { tenantId: fixture.tenantId, providerEventId: '1001' },
      }),
    ).toBe(1);
    expect(
      await prisma.message.count({
        where: {
          tenantId: fixture.tenantId,
          direction: 'INBOUND',
          providerMessageId: '10',
        },
      }),
    ).toBe(1);
  });

  it('enforces the database-backed per-channel rate limit', async () => {
    const fixture = await fixtures(1);
    const first = update({
      updateId: 1_101,
      messageId: 21,
      chatId: 710,
      text: 'one',
    });
    const second = update({
      updateId: 1_102,
      messageId: 22,
      chatId: 710,
      text: 'two',
    });
    if (first.kind !== 'text' || second.kind !== 'text') {
      throw new Error('Expected normalized text');
    }
    await expect(
      fixture.service.accept(fixture.channelAccountId, first),
    ).resolves.toBe('accepted');
    const error = await fixture.service
      .accept(fixture.channelAccountId, second)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(
      await prisma.inboundEvent.count({
        where: {
          tenantId: fixture.tenantId,
          channelAccountId: fixture.channelAccountId,
        },
      }),
    ).toBe(1);
  });

  it('debounces rapid same-chat messages in provider order into one logical reply', async () => {
    const fixture = await fixtures();
    for (const item of [
      { updateId: 2_002, messageId: 12, text: 'second' },
      { updateId: 2_001, messageId: 11, text: 'first' },
    ]) {
      const normalized = update({ ...item, chatId: 701 });
      if (normalized.kind !== 'text')
        throw new Error('Expected normalized text');
      await fixture.service.accept(fixture.channelAccountId, normalized);
    }
    const inboundOutbox = await prisma.outboxEvent.findMany({
      where: { tenantId: fixture.tenantId, type: 'telegram.inbound' },
      orderBy: { createdAt: 'asc' },
    });
    const sender = { sendMessage: vi.fn() } as unknown as TelegramSender;
    const processor = new TelegramProcessor(
      prisma as unknown as PrismaService,
      sender,
    );
    await Promise.all(
      inboundOutbox.map((event) =>
        processor.process({
          outboxId: event.id,
          tenantId: fixture.tenantId,
          type: event.type,
          payload: event.payload,
        }),
      ),
    );
    const replies = await prisma.message.findMany({
      where: {
        tenantId: fixture.tenantId,
        direction: 'OUTBOUND',
        authorType: 'BOT',
      },
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('first\nsecond');
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it('does not replay an ambiguous remote send after a network failure', async () => {
    const fixture = await fixtures();
    const normalized = update({
      updateId: 3_001,
      messageId: 30,
      chatId: 702,
      text: 'hello',
    });
    if (normalized.kind !== 'text') throw new Error('Expected normalized text');
    await fixture.service.accept(fixture.channelAccountId, normalized);
    const inboundOutbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, type: 'telegram.inbound' },
    });
    const sender = { sendMessage: vi.fn() } as unknown as TelegramSender;
    const processor = new TelegramProcessor(
      prisma as unknown as PrismaService,
      sender,
    );
    await processor.process({
      outboxId: inboundOutbox.id,
      tenantId: fixture.tenantId,
      type: inboundOutbox.type,
      payload: inboundOutbox.payload,
    });
    const sendOutbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, type: 'telegram.send' },
    });
    const sendEvent = {
      outboxId: sendOutbox.id,
      tenantId: fixture.tenantId,
      type: sendOutbox.type,
      payload: sendOutbox.payload,
    };
    sender.sendMessage = vi
      .fn()
      .mockRejectedValue(new TelegramAmbiguousSendError());
    await processor.process(sendEvent);
    await processor.process(sendEvent);
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    const messageId = (sendOutbox.payload as { messageId: string }).messageId;
    await expect(
      prisma.message.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, id: messageId },
      }),
    ).resolves.toMatchObject({
      deliveryState: 'UNKNOWN',
      deliveryErrorCode: 'telegram_ambiguous_outcome',
      deliveryAttempts: 1,
    });
  });

  it('keeps chats isolated and retries an explicit Telegram rate limit', async () => {
    const fixture = await fixtures();
    for (const [chatId, updateId, messageId, text] of [
      [801, 4_001, 40, 'chat one'],
      [802, 4_002, 41, 'chat two'],
    ] as const) {
      const normalized = update({ chatId, updateId, messageId, text });
      if (normalized.kind !== 'text')
        throw new Error('Expected normalized text');
      await fixture.service.accept(fixture.channelAccountId, normalized);
    }

    const senderMock = vi.fn().mockRejectedValue(new TelegramApiError(429, 2));
    const processor = new TelegramProcessor(
      prisma as unknown as PrismaService,
      { sendMessage: senderMock } as unknown as TelegramSender,
    );
    const inbound = await prisma.outboxEvent.findMany({
      where: { tenantId: fixture.tenantId, type: 'telegram.inbound' },
      orderBy: { createdAt: 'asc' },
    });
    for (const event of inbound) {
      await processor.process({
        outboxId: event.id,
        tenantId: fixture.tenantId,
        type: event.type,
        payload: event.payload,
      });
    }
    const replies = await prisma.message.findMany({
      where: { tenantId: fixture.tenantId, direction: 'OUTBOUND' },
      orderBy: { providerChatId: 'asc' },
    });
    expect(replies).toHaveLength(2);
    expect(replies.map((reply) => reply.text).sort()).toEqual([
      'chat one',
      'chat two',
    ]);

    const sendEvent = await prisma.outboxEvent.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, type: 'telegram.send' },
      orderBy: { createdAt: 'asc' },
    });
    const queueEvent = {
      outboxId: sendEvent.id,
      tenantId: fixture.tenantId,
      type: sendEvent.type,
      payload: sendEvent.payload,
    };
    await expect(processor.process(queueEvent)).rejects.toBeInstanceOf(
      TelegramApiError,
    );
    const replyId = (sendEvent.payload as { messageId: string }).messageId;
    await expect(
      prisma.message.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, id: replyId },
      }),
    ).resolves.toMatchObject({ deliveryState: 'PENDING', deliveryAttempts: 1 });

    senderMock.mockResolvedValue({ messageId: '444' });
    await processor.process(queueEvent);
    await expect(
      prisma.message.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, id: replyId },
      }),
    ).resolves.toMatchObject({
      deliveryState: 'SENT',
      deliveryAttempts: 2,
      providerMessageId: '444',
    });
  });

  it('publishes durable outbox rows to BullMQ and produces one end-to-end echo', async () => {
    const fixture = await fixtures();
    const normalized = update({
      updateId: 5_001,
      messageId: 50,
      chatId: 901,
      text: 'queued echo',
    });
    if (normalized.kind !== 'text') throw new Error('Expected normalized text');
    expect(
      await fixture.service.accept(fixture.channelAccountId, normalized),
    ).toBe('accepted');
    expect(
      await fixture.service.accept(fixture.channelAccountId, normalized),
    ).toBe('duplicate');

    const sendMessage = vi.fn().mockResolvedValue({ messageId: '902' });
    const processor = new TelegramProcessor(
      prisma as unknown as PrismaService,
      { sendMessage } as unknown as TelegramSender,
    );
    const runtime = new TelegramQueueRuntime(
      config({ REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379' }),
      prisma as unknown as PrismaService,
      processor,
    );
    await runtime.onModuleInit();
    try {
      const deadline = Date.now() + 15_000;
      let reply = null;
      while (Date.now() < deadline) {
        reply = await prisma.message.findFirst({
          where: {
            tenantId: fixture.tenantId,
            direction: 'OUTBOUND',
            authorType: 'BOT',
          },
        });
        if (reply?.deliveryState === 'SENT') break;
        if (
          reply?.deliveryState === 'FAILED' ||
          reply?.deliveryState === 'UNKNOWN'
        ) {
          throw new Error(`Echo delivery ended in ${reply.deliveryState}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(reply).toMatchObject({
        text: 'queued echo',
        deliveryState: 'SENT',
        providerMessageId: '902',
      });
      expect(
        sendMessage.mock.calls.filter(
          ([chatId, text]) => chatId === '901' && text === 'queued echo',
        ),
      ).toHaveLength(1);
      expect(
        await prisma.message.count({
          where: { tenantId: fixture.tenantId, direction: 'OUTBOUND' },
        }),
      ).toBe(1);
      expect(
        await prisma.inboundEvent.count({
          where: {
            tenantId: fixture.tenantId,
            providerEventId: '5001',
            status: 'PROCESSED',
          },
        }),
      ).toBe(1);
    } finally {
      await runtime.onModuleDestroy();
    }
  });
});
