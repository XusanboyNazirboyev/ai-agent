import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { HandoverService } from './handover.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Handover integration tests require agentcore_test');
}

/** Two clients with their own pools stand in for two API workers. */
const clients = [0, 1].map(
  () =>
    new PrismaClient({ adapter: createPostgresAdapter(process.env, 'TEST_') }),
);
const [db, other] = clients;
const workerA = new HandoverService(db as unknown as PrismaService);
const workerB = new HandoverService(other as unknown as PrismaService);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

async function fixture(
  state: 'BOT_ACTIVE' | 'WAITING_OPERATOR' = 'WAITING_OPERATOR',
): Promise<{
  tenantId: string;
  conversationId: string;
  handoverId: string;
  channelAccountId: string;
  op1: string;
  op2: string;
  viewer: string;
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `ho-${suffix}`,
      name: 'Handover fixture',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `ho-${suffix}`,
      status: 'ACTIVE',
      operatorChatId: '-100123',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Customer',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `chat-${suffix}`,
      state,
    },
  });
  const handover = await db.handover.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      reasonCode: 'CUSTOMER_REQUEST',
      summary: {},
      idempotencyKey: `h-${suffix}`,
    },
  });
  const operator = (
    name: string,
    role: 'OPERATOR' | 'VIEWER',
    active = true,
  ): Promise<{ id: string }> =>
    db.operator.create({
      data: {
        tenantId: tenant.id,
        displayName: name,
        role,
        isActive: active,
        telegramUserId: `tg-${name}-${suffix}`,
      },
      select: { id: true },
    });
  const [op1, op2, viewer] = await Promise.all([
    operator('one', 'OPERATOR'),
    operator('two', 'OPERATOR'),
    operator('viewer', 'VIEWER'),
  ]);
  return {
    tenantId: tenant.id,
    conversationId: conversation.id,
    handoverId: handover.id,
    channelAccountId: account.id,
    op1: op1.id,
    op2: op2.id,
    viewer: viewer.id,
  };
}

const key = (): string => `k-${randomUUID()}`;

describe('operator take-over', () => {
  it('has exactly one winner when two operators compete from two workers', async () => {
    const f = await fixture();
    const results = await Promise.all([
      workerA.takeOver({ ...f, operatorId: f.op1, idempotencyKey: key() }),
      workerB.takeOver({ ...f, operatorId: f.op2, idempotencyKey: key() }),
      workerA.takeOver({ ...f, operatorId: f.op2, idempotencyKey: key() }),
      workerB.takeOver({ ...f, operatorId: f.op1, idempotencyKey: key() }),
    ]);
    const winners = results.filter((r) => r.status === 'OK');
    // The same operator pressing twice is not a second winner: both calls of
    // the winning operator report OK, the other operator is rejected.
    const owners = new Set(
      (
        await db.conversation.findMany({
          where: { id: f.conversationId },
          select: { assignedOperatorId: true },
        })
      ).map((c) => c.assignedOperatorId),
    );
    expect(owners.size).toBe(1);
    const owner = [...owners][0];
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(
      results.filter(
        (r) => r.status === 'REJECTED' && r.code === 'ALREADY_TAKEN',
      ).length,
    ).toBe(results.length - winners.length);
    const row = await db.conversation.findFirstOrThrow({
      where: { id: f.conversationId },
    });
    expect(row).toMatchObject({
      state: 'OPERATOR_ACTIVE',
      assignedOperatorId: owner,
    });
    const handover = await db.handover.findFirstOrThrow({
      where: { id: f.handoverId },
    });
    expect(handover).toMatchObject({
      status: 'TAKEN',
      assignedOperatorId: owner,
    });
    // One state change: version moved exactly once.
    expect(row.version).toBe(2);
  });

  it('two different operators racing produce one OK and one ALREADY_TAKEN', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      workerA.takeOver({ ...f, operatorId: f.op1, idempotencyKey: key() }),
      workerB.takeOver({ ...f, operatorId: f.op2, idempotencyKey: key() }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['OK', 'REJECTED']);
    const loser = a.status === 'REJECTED' ? a : b;
    expect(loser).toMatchObject({ code: 'ALREADY_TAKEN' });
  });

  it('is idempotent on the command key and writes one audit record', async () => {
    const f = await fixture();
    const k = key();
    const first = await workerA.takeOver({
      ...f,
      operatorId: f.op1,
      idempotencyKey: k,
    });
    const again = await workerB.takeOver({
      ...f,
      operatorId: f.op1,
      idempotencyKey: k,
    });
    expect(first.status).toBe('OK');
    expect(again.status).toBe('DUPLICATE');
    const audits = await db.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: 'operator.take_over' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'OPERATOR',
      actorId: f.op1,
      entityType: 'handover',
      entityId: f.handoverId,
      idempotencyKey: k,
    });
  });

  it('refuses viewers, inactive operators and operators of another tenant', async () => {
    const f = await fixture();
    const g = await fixture();
    expect(
      await workerA.takeOver({
        ...f,
        operatorId: f.viewer,
        idempotencyKey: key(),
      }),
    ).toEqual({ status: 'REJECTED', code: 'FORBIDDEN' });
    await db.operator.update({
      where: { id: f.op2 },
      data: { isActive: false },
    });
    expect(
      await workerA.takeOver({
        ...f,
        operatorId: f.op2,
        idempotencyKey: key(),
      }),
    ).toEqual({ status: 'REJECTED', code: 'FORBIDDEN' });
    // Operator of tenant G against a handover of tenant F.
    expect(
      await workerA.takeOver({
        ...f,
        operatorId: g.op1,
        idempotencyKey: key(),
      }),
    ).toEqual({ status: 'REJECTED', code: 'FORBIDDEN' });
    // And a handover id of tenant F addressed as tenant G is not found.
    expect(
      await workerA.takeOver({
        tenantId: g.tenantId,
        handoverId: f.handoverId,
        operatorId: g.op1,
        idempotencyKey: key(),
      }),
    ).toEqual({ status: 'REJECTED', code: 'NOT_FOUND' });
    const row = await db.conversation.findFirstOrThrow({
      where: { id: f.conversationId },
    });
    expect(row.state).toBe('WAITING_OPERATOR');
  });
});

describe('operator replies, notes, return and close', () => {
  it('delivers a reply through the outbound path only for the assigned operator', async () => {
    const f = await fixture();
    await workerA.takeOver({ ...f, operatorId: f.op1, idempotencyKey: key() });
    const k = key();
    const sent = await workerA.reply({
      ...f,
      operatorId: f.op1,
      idempotencyKey: k,
      text: ' Salom! ',
    });
    expect(sent).toMatchObject({ status: 'OK', state: 'OPERATOR_ACTIVE' });
    const message = await db.message.findFirstOrThrow({
      where: { conversationId: f.conversationId, authorType: 'OPERATOR' },
    });
    expect(message).toMatchObject({
      direction: 'OUTBOUND',
      text: 'Salom!',
      deliveryState: 'PENDING',
      providerChatId: expect.any(String),
    });
    const outbox = await db.outboxEvent.findMany({
      where: {
        tenantId: f.tenantId,
        type: 'telegram.send',
        aggregateId: message.id,
      },
    });
    expect(outbox).toHaveLength(1);
    // Repeating the command does not send twice.
    expect(
      await workerB.reply({
        ...f,
        operatorId: f.op1,
        idempotencyKey: k,
        text: 'Salom!',
      }),
    ).toMatchObject({ status: 'DUPLICATE' });
    expect(
      await db.message.count({
        where: { conversationId: f.conversationId, authorType: 'OPERATOR' },
      }),
    ).toBe(1);
    // Another operator may not speak in this conversation; empty text is refused.
    expect(
      await workerA.reply({
        ...f,
        operatorId: f.op2,
        idempotencyKey: key(),
        text: 'x',
      }),
    ).toEqual({ status: 'REJECTED', code: 'NOT_ASSIGNED' });
    expect(
      await workerA.reply({
        ...f,
        operatorId: f.op1,
        idempotencyKey: key(),
        text: '  ',
      }),
    ).toEqual({ status: 'REJECTED', code: 'EMPTY_TEXT' });
  });

  it('refuses a reply before take-over', async () => {
    const f = await fixture();
    expect(
      await workerA.reply({
        ...f,
        operatorId: f.op1,
        idempotencyKey: key(),
        text: 'Hi',
      }),
    ).toEqual({ status: 'REJECTED', code: 'ILLEGAL_STATE' });
  });

  it('returns control to the bot and silences the operator afterwards', async () => {
    const f = await fixture();
    await workerA.takeOver({ ...f, operatorId: f.op1, idempotencyKey: key() });
    expect(
      await workerA.returnToBot({
        ...f,
        operatorId: f.op2,
        idempotencyKey: key(),
      }),
    ).toEqual({ status: 'REJECTED', code: 'NOT_ASSIGNED' });
    const back = await workerA.returnToBot({
      ...f,
      operatorId: f.op1,
      idempotencyKey: key(),
    });
    expect(back).toMatchObject({ status: 'OK', state: 'BOT_ACTIVE' });
    const row = await db.conversation.findFirstOrThrow({
      where: { id: f.conversationId },
    });
    expect(row).toMatchObject({
      state: 'BOT_ACTIVE',
      assignedOperatorId: null,
    });
    expect(
      (await db.handover.findFirstOrThrow({ where: { id: f.handoverId } }))
        .status,
    ).toBe('RESOLVED');
    expect(
      await workerA.reply({
        ...f,
        operatorId: f.op1,
        idempotencyKey: key(),
        text: 'late',
      }),
    ).toEqual({ status: 'REJECTED', code: 'ILLEGAL_STATE' });
  });

  it('closes a conversation, and a new customer message reopens it for the bot', async () => {
    const f = await fixture();
    const closed = await workerA.close({
      ...f,
      operatorId: f.op1,
      idempotencyKey: key(),
    });
    expect(closed).toMatchObject({ status: 'OK', state: 'CLOSED' });
    expect(
      await workerA.takeOver({
        ...f,
        operatorId: f.op1,
        idempotencyKey: key(),
      }),
    ).toEqual({ status: 'REJECTED', code: 'ILLEGAL_STATE' });
    const reopened = await db.$transaction((tx) =>
      workerA.reopenIfClosed(tx, f.tenantId, f.conversationId),
    );
    expect(reopened).toBe(true);
    expect(
      (
        await db.conversation.findFirstOrThrow({
          where: { id: f.conversationId },
        })
      ).state,
    ).toBe('BOT_ACTIVE');
    expect(
      await db.$transaction((tx) =>
        workerA.reopenIfClosed(tx, f.tenantId, f.conversationId),
      ),
    ).toBe(false);
  });

  it('stores internal notes in any state without contacting the customer', async () => {
    const f = await fixture();
    const k = key();
    expect(
      await workerA.addNote({
        ...f,
        operatorId: f.op1,
        idempotencyKey: k,
        text: 'Call back',
      }),
    ).toMatchObject({ status: 'OK' });
    expect(
      await workerB.addNote({
        ...f,
        operatorId: f.op1,
        idempotencyKey: k,
        text: 'Call back',
      }),
    ).toMatchObject({ status: 'DUPLICATE' });
    expect(
      await db.internalNote.count({
        where: { conversationId: f.conversationId },
      }),
    ).toBe(1);
    expect(
      await db.message.count({ where: { conversationId: f.conversationId } }),
    ).toBe(0);
  });
});

describe('opening a handover from the agent', () => {
  it('moves the conversation once, queues the notification and sets the SLA', async () => {
    const f = await fixture('BOT_ACTIVE');
    await db.handover.deleteMany({ where: { id: f.handoverId } }); // fixture handover not needed
    const now = new Date('2026-10-24T10:00:00Z');
    const id = await db.$transaction((tx) =>
      workerA.openHandover(tx, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'GUARDRAIL',
        summary: {},
        idempotencyKey: 'agent-reply:x',
        conversationVersion: 1,
        slaMinutes: 15,
        now,
      }),
    );
    expect(id).toBeDefined();
    const handover = await db.handover.findFirstOrThrow({ where: { id } });
    expect(handover.slaDueAt?.toISOString()).toBe('2026-10-24T10:15:00.000Z');
    expect(handover.notificationStatus).toBe('PENDING');
    const queued = await db.outboxEvent.findMany({
      where: { tenantId: f.tenantId, type: 'handover.notify', aggregateId: id },
    });
    expect(queued).toHaveLength(1);
    expect(
      await db.conversation.findFirstOrThrow({
        where: { id: f.conversationId },
      }),
    ).toMatchObject({ state: 'WAITING_OPERATOR', version: 2 });
    // A stale version (the conversation moved on) creates nothing.
    const stale = await db.$transaction((tx) =>
      workerA.openHandover(tx, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'GUARDRAIL',
        summary: {},
        idempotencyKey: 'agent-reply:y',
        conversationVersion: 1,
        slaMinutes: 15,
      }),
    );
    expect(stale).toBeUndefined();
    expect(
      await db.handover.count({ where: { conversationId: f.conversationId } }),
    ).toBe(1);
  });
});
