import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { InboxReadService } from './inbox-read.service.js';
import type { InboxPrincipal } from './session.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Inbox waiting-order integration tests require agentcore_test');
}

const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const read = new InboxReadService(db as unknown as PrismaService);

afterAll(async () => {
  await db.$disconnect();
});

describe('inbox waiting queue ordering', () => {
  it('orders the full queue by oldest active handover and paginates without gaps', async () => {
    const suffix = randomUUID();
    const tenant = await db.tenant.create({
      data: {
        slug: `wait-${suffix}`,
        name: 'Waiting order fixture',
        defaultLocale: 'en',
        supportedLocales: ['en'],
        timezone: 'UTC',
        packKey: 'education',
        packVersion: '1',
      },
    });
    const account = await db.channelAccount.create({
      data: {
        tenantId: tenant.id,
        channelType: 'telegram',
        externalAccountId: `wait-${suffix}`,
        status: 'ACTIVE',
      },
    });

    const principal: InboxPrincipal = {
      tenantId: tenant.id,
      operatorId: randomUUID(),
      role: 'ADMIN',
      sessionId: randomUUID(),
    };
    const openedAt = [
      new Date('2026-11-01T08:00:00.000Z'),
      new Date('2026-11-02T08:00:00.000Z'),
      new Date('2026-11-03T08:00:00.000Z'),
    ];
    const expectedIds: string[] = [];

    for (let index = 0; index < openedAt.length; index += 1) {
      const contact = await db.contact.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          providerUserId: `wait-user-${index}-${suffix}`,
          name: `Waiting customer ${index}`,
        },
      });
      const conversation = await db.conversation.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          contactId: contact.id,
          providerChatId: `wait-chat-${index}-${suffix}`,
          state: 'WAITING_OPERATOR',
        },
      });
      await db.handover.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          reasonCode: 'CUSTOMER_REQUEST',
          summary: {},
          openedAt: openedAt[index],
        },
      });
      expectedIds.push(conversation.id);
    }

    const firstPage = await read.list(principal, {
      scope: 'waiting',
      limit: 2,
    });
    expect(firstPage.items.map((item) => item.id)).toEqual(expectedIds.slice(0, 2));
    expect(firstPage.items.map((item) => item.waitingSince)).toEqual(
      openedAt.slice(0, 2).map((date) => date.toISOString()),
    );
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await read.list(principal, {
      scope: 'waiting',
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.items.map((item) => item.id)).toEqual(expectedIds.slice(2));
    expect(secondPage.nextCursor).toBeNull();

    const combined = [...firstPage.items, ...secondPage.items];
    expect(new Set(combined.map((item) => item.id)).size).toBe(3);
  });
});
