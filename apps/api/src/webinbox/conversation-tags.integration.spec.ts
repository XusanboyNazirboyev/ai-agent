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
import { TagsService } from '../tags/tags.service.js';
import { ConversationTagsController } from './conversation-tags.controller.js';
import { InboxReadService } from './inbox-read.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Conversation tag tests require agentcore_test');
// RLS plan S8b: fixtures on the owner, the code under test on the app role
// under the principal's tenant, as the session guard sets it.
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
const tagsService = new TagsService(prisma);
const controller = tenantScoped(new ConversationTagsController(tagsService));
const inbox = tenantScoped(new InboxReadService(prisma));
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

async function world() {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `ctag-${id}`,
      name: 'T',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `t-${id}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      providerUserId: `u-${id}`,
      name: 'Customer',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${id}`,
    },
  });
  const lead = await db.lead.create({
    data: {
      tenantId: t.id,
      contactId: contact.id,
      conversationId: conversation.id,
      score: 'WARM',
      summary: 's',
      idempotencyKey: `l-${id}`,
    },
  });
  const ops: Record<Role, string> = {} as never;
  for (const role of ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as Role[])
    ops[role] = (
      await db.operator.create({
        data: { tenantId: t.id, displayName: role, role },
      })
    ).id;
  const as = (role: Role) =>
    ({
      principal: {
        tenantId: t.id,
        operatorId: ops[role],
        role,
        sessionId: 's',
      },
    }) as never;
  return {
    tenantId: t.id,
    leadId: lead.id,
    conversationId: conversation.id,
    channelAccountId: account.id,
    providerChatId: conversation.providerChatId,
    pipelineId: lead.pipelineId,
    ops,
    as,
  };
}

const status = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};

async function tag(tenantId: string, name: string) {
  return db.tag.create({ data: { tenantId, name } });
}

describe('tags on conversations (P1.8, ADR 071)', () => {
  it('an operator tags a chat; the list shows the tags and filters by one', async () => {
    const w = await world();
    const delivery = await tag(w.tenantId, 'Delivery');
    const vip = await tag(w.tenantId, 'VIP');
    const set = await controller.setTags(w.as('OPERATOR'), w.conversationId, {
      tagIds: [vip.id, delivery.id],
    });
    expect(set.tags.map((t) => t.name)).toEqual(['Delivery', 'VIP']);

    const principal = (w.as('VIEWER') as { principal: never }).principal;
    const all = await inbox.list(principal, { scope: 'all' });
    expect(all.items.find((i) => i.id === w.conversationId)?.tags).toHaveLength(
      2,
    );
    const filtered = await inbox.list(principal, {
      scope: 'all',
      tagId: delivery.id,
    });
    expect(filtered.items.map((i) => i.id)).toEqual([w.conversationId]);
    // The waiting queue is built in SQL: the same filter applies there.
    await db.conversation.update({
      where: { id: w.conversationId },
      data: { state: 'WAITING_OPERATOR' },
    });
    const other = await tag(w.tenantId, 'Other');
    expect(
      (await inbox.list(principal, { scope: 'waiting', tagId: vip.id })).items,
    ).toHaveLength(1);
    expect(
      (await inbox.list(principal, { scope: 'waiting', tagId: other.id }))
        .items,
    ).toHaveLength(0);
    expect(
      (await inbox.view(principal, w.conversationId))?.conversation.tags,
    ).toHaveLength(2);

    // Removing one; archiving a tag takes it off the chat too.
    await controller.setTags(w.as('ADMIN'), w.conversationId, {
      tagIds: [vip.id],
    });
    await tenantScoped(tagsService, { tenantArg: 0 }).archive(
      w.tenantId,
      w.ops.OWNER,
      vip.id,
    );
    expect(
      await db.conversationTag.count({ where: { tenantId: w.tenantId } }),
    ).toBe(0);
    const audit = await db.auditEvent.findMany({
      where: { tenantId: w.tenantId, action: 'conversation.tags_set' },
    });
    expect(audit).toHaveLength(2);
  });

  it('refuses viewers, unknown or foreign tags, other tenants and erased contacts', async () => {
    const w = await world();
    const other = await world();
    const mine = await tag(w.tenantId, 'Mine');
    const theirs = await tag(other.tenantId, 'Theirs');
    expect(
      await status(() =>
        controller.setTags(w.as('VIEWER'), w.conversationId, {
          tagIds: [mine.id],
        }),
      ),
    ).toBe(403);
    expect(
      await status(() =>
        controller.setTags(w.as('OPERATOR'), w.conversationId, {
          tagIds: [theirs.id],
        }),
      ),
    ).toBe(400);
    expect(
      await status(() =>
        controller.setTags(other.as('OWNER'), w.conversationId, {
          tagIds: [theirs.id],
        }),
      ),
    ).toBe(404);
    await db.contact.updateMany({
      where: { tenantId: w.tenantId },
      data: { deletedAt: new Date() },
    });
    expect(
      await status(() =>
        controller.setTags(w.as('OPERATOR'), w.conversationId, {
          tagIds: [mine.id],
        }),
      ),
    ).toBe(404);
  });
});
