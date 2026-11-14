/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { TodayController } from './today.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Today tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
const controller = new TodayController(prisma);
afterAll(async () => {
  await db.$disconnect();
});

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

async function world() {
  const suffix = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `today-${suffix}`,
      name: 'Today fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'travel',
      packVersion: '1',
    },
  });
  const owner = await db.operator.create({
    data: { tenantId: t.id, displayName: 'Owner', role: 'OWNER' },
  });
  const request = (role: Role, operatorId = owner.id) =>
    ({
      principal: {
        tenantId: t.id,
        operatorId,
        role,
        sessionId: randomUUID(),
      },
    }) as never;
  return { tenantId: t.id, suffix, owner, request };
}

async function waiting(
  w: Awaited<ReturnType<typeof world>>,
  state: 'WAITING_OPERATOR' | 'BOT_ACTIVE',
  slaInMinutes: number | null,
) {
  const account =
    (await db.channelAccount.findFirst({ where: { tenantId: w.tenantId } })) ??
    (await db.channelAccount.create({
      data: {
        tenantId: w.tenantId,
        channelType: 'telegram',
        externalAccountId: `acc-${w.suffix}`,
        status: 'ACTIVE',
        isTestAccount: true,
      },
    }));
  const id = randomUUID();
  const contact = await db.contact.create({
    data: {
      tenantId: w.tenantId,
      channelAccountId: account.id,
      providerUserId: `u-${id}`,
      name: 'Customer',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: w.tenantId,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${id}`,
      state,
    },
  });
  if (slaInMinutes !== null) {
    const h = await db.handover.create({
      data: {
        tenantId: w.tenantId,
        conversationId: conversation.id,
        reasonCode: 'CUSTOMER_REQUEST',
        summary: {},
        idempotencyKey: `h-${id}`,
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE handovers SET sla_due_at = now() + ($1 || ' minutes')::interval WHERE id = $2::uuid`,
      String(slaInMinutes),
      h.id,
    );
  }
  return { conversationId: conversation.id, contactId: contact.id };
}

async function lead(
  w: Awaited<ReturnType<typeof world>>,
  from: { conversationId: string; contactId: string },
  options: { hoursAgo?: number; archived?: boolean } = {},
) {
  const created = await db.lead.create({
    data: {
      tenantId: w.tenantId,
      contactId: from.contactId,
      conversationId: from.conversationId,
      score: 'WARM',
      summary: 's',
      idempotencyKey: `l-${randomUUID()}`,
    },
  });
  if (options.hoursAgo !== undefined)
    await prisma.$executeRawUnsafe(
      `UPDATE leads SET created_at = now() - ($1 || ' hours')::interval WHERE id = $2::uuid`,
      String(options.hoursAgo),
      created.id,
    );
  if (options.archived)
    await prisma.$executeRawUnsafe(
      `UPDATE leads SET archived_at = now() WHERE id = $1::uuid`,
      created.id,
    );
}

describe('Today summary (UX review A4)', () => {
  it('counts the customers waiting, those past their deadline and the new leads of the last day', async () => {
    const w = await world();
    const late = await waiting(w, 'WAITING_OPERATOR', -60);
    await waiting(w, 'WAITING_OPERATOR', 30);
    const answered = await waiting(w, 'BOT_ACTIVE', null);
    await lead(w, late);
    await lead(w, answered, { hoursAgo: 48 });
    await lead(w, late, { archived: true });
    const today = await controller.summary(w.request('OPERATOR'));
    expect(today.waiting).toEqual({ total: 2, overdue: 1 });
    // Only the one created now: not the 2-day-old lead, not the archived one.
    expect(today.newLeads).toBe(1);
  });

  it('gives the getting-started checklist to owners and admins only', async () => {
    const w = await world();
    const blank = await controller.summary(w.request('OWNER'));
    expect(blank.checklist).toEqual({
      channelConnected: false,
      hasContent: false,
      teamInvited: false,
      operatorGroup: false,
      testedAssistant: false,
    });
    for (const role of ['OPERATOR', 'VIEWER'] as Role[])
      expect((await controller.summary(w.request(role))).checklist).toBeNull();
    expect(
      (await controller.summary(w.request('ADMIN'))).checklist,
    ).not.toBeNull();

    // A test account does not count as a connected channel.
    await waiting(w, 'BOT_ACTIVE', null);
    expect(
      (await controller.summary(w.request('OWNER'))).checklist,
    ).toMatchObject({
      channelConnected: false,
    });
    await db.channelAccount.create({
      data: {
        tenantId: w.tenantId,
        channelType: 'telegram',
        externalAccountId: `real-${w.suffix}`,
        status: 'DISABLED',
        operatorChatId: '-1001',
      },
    });
    await db.knowledgeDocument.create({
      data: {
        tenantId: w.tenantId,
        title: 'Opening hours',
        source: `faq:${w.suffix}`,
        sourceUpdatedAt: new Date(),
        contentHash: 'h'.repeat(64),
      },
    });
    await db.operator.create({
      data: { tenantId: w.tenantId, displayName: 'Second', role: 'OPERATOR' },
    });
    expect(
      (await controller.summary(w.request('OWNER'))).checklist,
    ).toMatchObject({
      channelConnected: true,
      operatorGroup: true,
      teamInvited: true,
    });
    // Trying the assistant in the test chat leaves one audit row; that is all.
    await db.auditEvent.create({
      data: {
        tenantId: w.tenantId,
        actorType: 'OPERATOR',
        actorId: w.owner.id,
        action: 'assistant.test_chat_used',
        entityType: 'tenant',
        entityId: w.tenantId,
        safeInputSummary: {},
      },
    });
    expect(
      (await controller.summary(w.request('OWNER'))).checklist,
    ).toMatchObject({ testedAssistant: true });
  });

  it('never counts another workspace', async () => {
    const a = await world();
    const b = await world();
    await waiting(a, 'WAITING_OPERATOR', -10);
    const other = await controller.summary(b.request('OWNER'));
    expect(other.waiting).toEqual({ total: 0, overdue: 0 });
    expect(other.newLeads).toBe(0);
  });
});
