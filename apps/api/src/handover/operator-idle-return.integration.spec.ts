import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { OperatorIdleReturnService } from './operator-idle-return.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Idle return integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => {
  await db.$disconnect();
});

const service = (minutes = 2): OperatorIdleReturnService =>
  new OperatorIdleReturnService(
    db as unknown as PrismaService,
    {
      get: (key: string) =>
        key === 'OPERATOR_IDLE_RETURN_MINUTES' ? minutes : undefined,
    } as unknown as ConfigService<AppEnvironment, true>,
  );

const NOW = new Date('2026-11-04T11:00:00Z');
const AGO = (minutes: number): Date =>
  new Date(NOW.getTime() - minutes * 60_000);

interface Held {
  tenantId: string;
  conversationId: string;
  handoverId: string;
  second: { id: string };
  events: { id: string }[];
}

async function heldConversation(
  over: {
    state?: 'OPERATOR_ACTIVE' | 'WAITING_OPERATOR';
    lastFrom?: 'CUSTOMER' | 'OPERATOR';
    customerAgoMin?: number;
    takenAgoMin?: number;
  } = {},
): Promise<Held> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `idle-${suffix}`,
      name: 'Idle return fixture',
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
      channelType: 'telegram',
      externalAccountId: `idle-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
    },
  });
  const operator = await db.operator.create({
    data: {
      tenantId: tenant.id,
      displayName: 'Op',
      role: 'OPERATOR',
      telegramUserId: `tg-${suffix}`,
    },
  });
  const state = over.state ?? 'OPERATOR_ACTIVE';
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      state,
      assignedOperatorId: state === 'OPERATOR_ACTIVE' ? operator.id : null,
      language: 'uz',
      script: 'Latn',
    },
  });
  const handover = await db.handover.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      reasonCode: 'OPERATOR_INITIATED',
      summary: {},
      idempotencyKey: `h-${suffix}`,
      status: state === 'OPERATOR_ACTIVE' ? 'TAKEN' : 'OPEN',
      assignedOperatorId: state === 'OPERATOR_ACTIVE' ? operator.id : null,
      takenAt: state === 'OPERATOR_ACTIVE' ? AGO(over.takenAgoMin ?? 10) : null,
    },
  });
  const base = {
    tenantId: tenant.id,
    conversationId: conversation.id,
    channelAccountId: account.id,
    providerChatId: `c-${suffix}`,
    type: 'TEXT' as const,
  };
  const customerAt = AGO(over.customerAgoMin ?? 5);
  const first = await db.message.create({
    data: {
      ...base,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      text: 'IELTS kursi bormi?',
      sequence: 1,
      createdAt: new Date(customerAt.getTime() - 30_000),
    },
  });
  const second = await db.message.create({
    data: {
      ...base,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      text: 'Narxi qancha?',
      sequence: 2,
      createdAt: customerAt,
    },
  });
  if (over.lastFrom === 'OPERATOR') {
    await db.message.create({
      data: {
        ...base,
        authorType: 'OPERATOR',
        direction: 'OUTBOUND',
        text: 'Hozir aytaman',
        sequence: 3,
        deliveryState: 'SENT',
        createdAt: new Date(customerAt.getTime() + 10_000),
      },
    });
  }
  const events = [];
  for (const [index, message] of [first, second].entries()) {
    events.push(
      await db.inboundEvent.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          providerEventId: `e-${index}-${suffix}`,
          status: 'PROCESSED',
          processedAt: message.createdAt,
          redactedPayload: {
            providerChatId: `c-${suffix}`,
            providerMessageId: String(100 + index),
            conversationId: conversation.id,
            messageId: message.id,
          },
        },
      }),
    );
  }
  return {
    tenantId: tenant.id,
    conversationId: conversation.id,
    handoverId: handover.id,
    second,
    events,
  };
}

describe('operator idle return (ADR 038 amendment 1)', () => {
  it('returns an unanswered conversation to the bot and queues the customer messages again', async () => {
    const f = await heldConversation();
    expect(await service().scan(NOW, 2, { tenantId: f.tenantId })).toBe(1);

    const conversation = await db.conversation.findFirstOrThrow({
      where: { id: f.conversationId },
    });
    expect(conversation.state).toBe('BOT_ACTIVE');
    expect(conversation.assignedOperatorId).toBeNull();
    const handover = await db.handover.findFirstOrThrow({
      where: { id: f.handoverId },
    });
    expect(handover.status).toBe('RESOLVED');
    const events = await db.inboundEvent.findMany({
      where: { id: { in: f.events.map((event) => event.id) } },
    });
    expect(events.map((event) => event.status)).toEqual([
      'RECEIVED',
      'RECEIVED',
    ]);
    const outbox = await db.outboxEvent.findMany({
      where: { tenantId: f.tenantId, type: 'telegram.inbound' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toEqual({
      inboundEventId: f.events[1]!.id,
      conversationId: f.conversationId,
      messageId: f.second.id,
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: 'system.operator_idle_return' },
    });
    expect(audit.actorType).toBe('SYSTEM');
    expect(audit.safeInputSummary).toMatchObject({
      state: 'BOT_ACTIVE',
      minutes: 2,
      replayed: 2,
    });

    // A second pass finds nothing to do.
    expect(await service().scan(NOW, 2, { tenantId: f.tenantId })).toBe(0);
  });

  it('leaves the conversation with the operator when they replied, took it recently, or the customer just wrote', async () => {
    const replied = await heldConversation({ lastFrom: 'OPERATOR' });
    const justTaken = await heldConversation({ takenAgoMin: 1 });
    const fresh = await heldConversation({ customerAgoMin: 1 });
    const waiting = await heldConversation({ state: 'WAITING_OPERATOR' });
    for (const f of [replied, justTaken, fresh, waiting]) {
      expect(await service().scan(NOW, 2, { tenantId: f.tenantId })).toBe(0);
      const conversation = await db.conversation.findFirstOrThrow({
        where: { id: f.conversationId },
      });
      expect(conversation.state).not.toBe('BOT_ACTIVE');
    }
  });

  it('does nothing when turned off', async () => {
    const f = await heldConversation();
    expect(await service(0).scanDue(NOW)).toBe(0);
    const conversation = await db.conversation.findFirstOrThrow({
      where: { id: f.conversationId },
    });
    expect(conversation.state).toBe('OPERATOR_ACTIVE');
  });
});
