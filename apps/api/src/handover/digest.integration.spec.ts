import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { DigestService, localDate } from './digest.service.js';
import { HandoverNotificationService } from './handover-notification.service.js';
import type { NotifierTarget, OperatorNotifier } from './operator-notifier.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Digest integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const digest = (): DigestService =>
  new DigestService(prisma, { get: () => 9 } as unknown as ConfigService<
    AppEnvironment,
    true
  >);

async function tenant(
  withChat = true,
): Promise<{ tenantId: string; contactId: string; conversationId: string }> {
  const suffix = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `dg-${suffix}`,
      name: 'Digest fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `dg-${suffix}`,
      status: 'ACTIVE',
      operatorChatId: withChat ? '-100999' : null,
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Dilnoza',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
    },
  });
  return {
    tenantId: t.id,
    contactId: contact.id,
    conversationId: conversation.id,
  };
}
const queued = (tenantId: string): Promise<number> =>
  db.outboxEvent.count({ where: { tenantId, type: 'digest.morning' } });

describe('morning digest', () => {
  it('queues one digest per local day once the local hour is reached', async () => {
    const t = await tenant();
    const early = new Date('2026-10-26T02:00:00Z'); // 07:00 in Tashkent
    await digest().scanDue(early);
    expect(await queued(t.tenantId)).toBe(0);
    const morning = new Date('2026-10-26T05:00:00Z'); // 10:00
    await Promise.all([digest().scanDue(morning), digest().scanDue(morning)]);
    await digest().scanDue(new Date('2026-10-26T12:00:00Z'));
    expect(await queued(t.tenantId)).toBe(1);
    await digest().scanDue(new Date('2026-10-27T05:00:00Z')); // next local day
    expect(await queued(t.tenantId)).toBe(2);
    const event = await db.outboxEvent.findFirstOrThrow({
      where: { tenantId: t.tenantId, type: 'digest.morning' },
      orderBy: { createdAt: 'asc' },
    });
    expect(event.idempotencyKey).toBe(`digest:${t.tenantId}:2026-10-26`);
  });

  it('skips tenants without an operator group', async () => {
    const t = await tenant(false);
    await digest().scanDue(new Date('2026-10-26T05:00:00Z'));
    expect(await queued(t.tenantId)).toBe(0);
  });

  it('computes the local date in the tenant zone', () => {
    expect(localDate(new Date('2026-10-26T20:00:00Z'), 'Asia/Tashkent')).toBe(
      '2026-10-27',
    );
    expect(localDate(new Date('2026-10-26T20:00:00Z'), 'UTC')).toBe(
      '2026-10-26',
    );
  });

  it('posts hot and warm leads and the waiting count to the operator group', async () => {
    const t = await tenant();
    await db.lead.create({
      data: {
        tenantId: t.tenantId,
        contactId: t.contactId,
        conversationId: t.conversationId,
        score: 'HOT',
        reasonCodes: ['PHONE_PROVIDED', 'ASKED_TO_BOOK'],
        summary: 'x',
        idempotencyKey: `lead:${t.conversationId}`,
      },
    });
    await db.handover.create({
      data: {
        tenantId: t.tenantId,
        conversationId: t.conversationId,
        reasonCode: 'COMPLAINT',
        summary: {},
      },
    });
    const cards: string[] = [];
    const notifier = {
      kind: 'fake',
      postCard: (_t: NotifierTarget, card: { text: string }) => {
        cards.push(card.text);
        return Promise.resolve({ messageId: '1' });
      },
    } as unknown as OperatorNotifier;
    await new HandoverNotificationService(prisma, notifier).process({
      outboxId: randomUUID(),
      tenantId: t.tenantId,
      type: 'digest.morning',
      payload: { date: '2026-10-26' },
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('Morning digest 2026-10-26');
    expect(cards[0]).toContain('Waiting for an operator: 1');
    expect(cards[0]).toContain('HOT Dilnoza: PHONE_PROVIDED, ASKED_TO_BOOK');
    // An empty day says so.
    const empty = await tenant();
    await new HandoverNotificationService(prisma, notifier).process({
      outboxId: randomUUID(),
      tenantId: empty.tenantId,
      type: 'digest.morning',
      payload: { date: '2026-10-26' },
    });
    expect(cards[1]).toContain('No new hot or warm leads.');
  });
});
