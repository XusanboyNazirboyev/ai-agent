/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { InboxReadService } from './inbox-read.service.js';
import type { InboxPrincipal } from './session.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Inbox channel filter tests require agentcore_test');
const db = ownerClient();
const app = appClient();
const read = tenantScoped(
  new InboxReadService(app as unknown as PrismaService),
);
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

async function world() {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `chan-${suffix}`,
      name: 'Channel filter fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'general',
      packVersion: '1',
    },
  });
  const chat = async (channelType: string, name: string) => {
    const account = await db.channelAccount.create({
      data: {
        tenantId: tenant.id,
        channelType,
        externalAccountId: `${channelType}-${name}-${suffix}`,
        status: 'ACTIVE',
      },
    });
    const contact = await db.contact.create({
      data: {
        tenantId: tenant.id,
        channelAccountId: account.id,
        providerUserId: `u-${name}-${suffix}`,
        name,
      },
    });
    await db.conversation.create({
      data: {
        tenantId: tenant.id,
        channelAccountId: account.id,
        contactId: contact.id,
        providerChatId: `c-${name}-${suffix}`,
        state: 'BOT_ACTIVE',
      },
    });
    return account.id;
  };
  const tgA = await chat('telegram', 'Ali');
  await chat('telegram', 'Vali');
  await chat('instagram', 'Sardor');
  await chat('manual', 'Hand');
  const principal: InboxPrincipal = {
    tenantId: tenant.id,
    operatorId: randomUUID(),
    role: 'OPERATOR',
    sessionId: randomUUID(),
  };
  return { principal, tgA };
}

const names = (page: { items: { contactName: string | null }[] }) =>
  page.items.map((item) => item.contactName).sort();

describe('inbox channel filter (owner 2026-11-23)', () => {
  it('shows every chat, one messenger, or one account; never manual leads', async () => {
    const w = await world();
    const all = await read.list(w.principal, { scope: 'all', limit: 25 });
    expect(names(all)).toEqual(['Ali', 'Sardor', 'Vali']);
    expect(
      Object.fromEntries(all.items.map((i) => [i.contactName, i.channelType])),
    ).toEqual({ Ali: 'telegram', Vali: 'telegram', Sardor: 'instagram' });
    expect(
      names(
        await read.list(w.principal, {
          scope: 'all',
          channelType: 'instagram',
        }),
      ),
    ).toEqual(['Sardor']);
    expect(
      names(
        await read.list(w.principal, { scope: 'all', channelType: 'telegram' }),
      ),
    ).toEqual(['Ali', 'Vali']);
    expect(
      names(
        await read.list(w.principal, {
          scope: 'all',
          channelAccountId: w.tgA,
        }),
      ),
    ).toEqual(['Ali']);
    // Another tenant's account id finds nothing here.
    const other = await world();
    expect(
      (
        await read.list(w.principal, {
          scope: 'all',
          channelAccountId: other.tgA,
        })
      ).items,
    ).toEqual([]);
  });
});
