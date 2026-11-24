import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentConversationService } from '../../agent/agent-conversation.service.js';
import type { PrivilegedDatabase } from '../../persistence/privileged-database.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { runWithTenant } from '../../persistence/tenant-context.js';
import {
  appClient,
  ownerClient,
} from '../../persistence/testing/test-clients.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Instagram story integration tests require agentcore_test');
}
const db = ownerClient();
const app = appClient();
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

type BatchOrigin = (
  tenantId: string,
  conversationId: string,
  beforeSequence: number | undefined,
) => Promise<string | undefined>;
// The private reader the agent turn uses; it needs only Prisma.
const batchOrigin = (
  AgentConversationService.prototype as unknown as { batchOrigin: BatchOrigin }
).batchOrigin.bind({ prisma: app });

describe('Instagram story replies (ADR 090)', () => {
  it('stores the story mark and the agent turn reads it', async () => {
    const suffix = randomUUID();
    const tenant = await db.tenant.create({
      data: {
        slug: `story-${suffix}`,
        name: 'Story fixture',
        timezone: 'Asia/Tashkent',
        defaultLocale: 'uz-Latn',
        supportedLocales: ['uz-Latn'],
        packKey: 'education',
        packVersion: '1',
      },
    });
    const accountId = `8${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await db.channelAccount.create({
      data: {
        tenantId: tenant.id,
        channelType: 'instagram',
        externalAccountId: accountId,
        status: 'ACTIVE',
      },
    });
    const webhook = new InstagramWebhookService(
      app as unknown as PrismaService,
      { db } as PrivilegedDatabase,
    );
    const base = {
      kind: 'text' as const,
      accountId,
      customerId: '4242',
      receivedAt: new Date(),
    };
    expect(
      await webhook.accept({
        ...base,
        messageId: `d-${suffix}`,
        text: 'Salom',
      }),
    ).toBe('accepted');
    expect(
      await webhook.accept({
        ...base,
        messageId: `s-${suffix}`,
        text: 'Narxi qancha?',
        story: { id: 'S1', url: 'https://cdn.example/s1.jpg' },
      }),
    ).toBe('accepted');

    const messages = await db.message.findMany({
      where: { tenantId: tenant.id },
      orderBy: { sequence: 'asc' },
      select: { conversationId: true, sequence: true, richContent: true },
    });
    expect(messages.map((m) => m.richContent)).toEqual([
      null,
      {
        kind: 'story_reply',
        storyId: 'S1',
        url: 'https://cdn.example/s1.jpg',
      },
    ]);
    const conversationId = messages[0]!.conversationId;
    const origin = (from: number): Promise<string | undefined> =>
      runWithTenant(tenant.id, () =>
        batchOrigin(tenant.id, conversationId, from),
      );
    expect(await origin(1)).toBe('story_reply');
    expect(await origin(2)).toBe('story_reply');
    // A later batch without a story reply is an ordinary message again.
    expect(await origin(3)).toBeUndefined();
  });
});
