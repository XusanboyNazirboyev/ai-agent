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
  throw new Error('Inbox last-message tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const read = new InboxReadService(db as unknown as PrismaService);
afterAll(async () => {
  await db.$disconnect();
});

async function world(state: 'WAITING_OPERATOR' | 'BOT_ACTIVE') {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `last-${suffix}`,
      name: 'Last message fixture',
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
      externalAccountId: `last-${suffix}`,
      status: 'ACTIVE',
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
      providerChatId: `c-${suffix}`,
      state,
    },
  });
  const say = (
    sequence: number,
    authorType: 'CUSTOMER' | 'BOT' | 'OPERATOR',
    text: string,
  ) =>
    db.message.create({
      data: {
        tenantId: tenant.id,
        conversationId: conversation.id,
        channelAccountId: account.id,
        authorType,
        direction: authorType === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND',
        text,
        sequence,
        providerChatId: `c-${suffix}`,
      },
    });
  const principal: InboxPrincipal = {
    tenantId: tenant.id,
    operatorId: randomUUID(),
    role: 'OPERATOR',
    sessionId: randomUUID(),
  };
  return { principal, conversation, say, tenant };
}

describe('conversation list: last message preview', () => {
  it('shows the newest message by sequence, on one line, cut at 120 characters', async () => {
    const w = await world('BOT_ACTIVE');
    await w.say(1, 'CUSTOMER', 'first');
    await w.say(3, 'BOT', `Line one\n\n   line   two ${'x'.repeat(200)}`);
    await w.say(2, 'OPERATOR', 'older by sequence');
    const page = await read.list(w.principal, { scope: 'all', limit: 25 });
    const item = page.items.find((i) => i.id === w.conversation.id)!;
    expect(item.lastMessage?.author).toBe('BOT');
    expect(item.lastMessage?.text.startsWith('Line one line two xxx')).toBe(
      true,
    );
    expect(item.lastMessage?.text).not.toMatch(/\s{2}|\n/u);
    expect(item.lastMessage?.text.length).toBe(120);
    expect(item.lastMessage?.text.endsWith('…')).toBe(true);
    expect(item.lastMessage?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('is there in the waiting queue too, and null for a conversation without messages', async () => {
    const w = await world('WAITING_OPERATOR');
    await db.handover.create({
      data: {
        tenantId: w.tenant.id,
        conversationId: w.conversation.id,
        reasonCode: 'CUSTOMER_REQUEST',
        summary: {},
        idempotencyKey: `h-${randomUUID()}`,
      },
    });
    const empty = await read.list(w.principal, { scope: 'waiting', limit: 25 });
    expect(empty.items[0]?.lastMessage).toBeNull();
    await w.say(1, 'CUSTOMER', 'Need a human please');
    const full = await read.list(w.principal, { scope: 'waiting', limit: 25 });
    expect(full.items[0]?.lastMessage).toMatchObject({
      text: 'Need a human please',
      author: 'CUSTOMER',
    });
  });

  it("never shows another workspace's message", async () => {
    const a = await world('BOT_ACTIVE');
    const b = await world('BOT_ACTIVE');
    await a.say(1, 'CUSTOMER', 'secret of A');
    const other = await read.list(b.principal, { scope: 'all', limit: 25 });
    expect(JSON.stringify(other)).not.toContain('secret of A');
  });
});
