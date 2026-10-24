import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { DEFAULT_FOLLOW_UP_POLICY } from '../core/followup/policy.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { UZ_LATN } from '../locales/locale-packs.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { TelegramApiError } from '../channels/telegram/telegram-sender.js';
import { TelegramProcessor } from '../channels/telegram/telegram-processor.js';
import type { TelegramSender } from '../channels/telegram/telegram-sender.js';
import { FollowUpService } from './follow-up.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Follow-up integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const other = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => {
  await Promise.all([db.$disconnect(), other.$disconnect()]);
});

const config = (enabled: boolean): ConfigService<AppEnvironment, true> =>
  ({
    get: (key: string) =>
      ({
        FOLLOWUP_ENABLED: enabled,
        FOLLOWUP_AFTER_HOURS: 24,
        FOLLOWUP_MAX_PER_CONVERSATION: 1,
        FOLLOWUP_QUIET_START_HOUR: 21,
        FOLLOWUP_QUIET_END_HOUR: 9,
      })[key],
  }) as unknown as ConfigService<AppEnvironment, true>;
const service = (client = db, enabled = true): FollowUpService =>
  new FollowUpService(client as unknown as PrismaService, config(enabled));

const NOW = new Date('2026-10-26T07:00:00Z'); // 12:00 in Asia/Tashkent
const HOURS = (n: number): Date => new Date(NOW.getTime() - n * 3_600_000);

async function silentConversation(
  over: {
    state?: 'BOT_ACTIVE' | 'OPERATOR_ACTIVE';
    optOut?: boolean;
    consent?: 'UNKNOWN' | 'REVOKED';
    lastFrom?: 'BOT' | 'CUSTOMER';
    delivered?: 'SENT' | 'PENDING';
    value?: boolean;
    ageHours?: number;
    timezone?: string;
  } = {},
): Promise<{ tenantId: string; conversationId: string }> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `fu-${suffix}`,
      name: 'Follow-up fixture',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn'],
      timezone: over.timezone ?? 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `fu-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      marketingOptOut: over.optOut ?? false,
      consentStatus: over.consent ?? 'UNKNOWN',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      state: over.state ?? 'BOT_ACTIVE',
      language: 'uz',
      script: 'Latn',
    },
  });
  const at = HOURS(over.ageHours ?? 30);
  const base = {
    tenantId: tenant.id,
    conversationId: conversation.id,
    channelAccountId: account.id,
    providerChatId: `c-${suffix}`,
    type: 'TEXT' as const,
  };
  await db.message.create({
    data: {
      ...base,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      text: 'IELTS kursi?',
      sequence: 1,
      createdAt: new Date(at.getTime() - 60_000),
    },
  });
  await db.message.create({
    data: {
      ...base,
      authorType: over.lastFrom === 'CUSTOMER' ? 'CUSTOMER' : 'BOT',
      direction: over.lastFrom === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND',
      text: 'Sizga mos variantlar...',
      sequence: 2,
      deliveryState: over.delivered ?? 'SENT',
      createdAt: at,
    },
  });
  if (over.value !== false) {
    const bot = await db.message.findFirstOrThrow({
      where: { conversationId: conversation.id, sequence: 2 },
    });
    await db.shownOffer.create({
      data: {
        tenantId: tenant.id,
        conversationId: conversation.id,
        messageId: bot.id,
        offerRef: 'item:x',
        facts: [],
      },
    });
  }
  return { tenantId: tenant.id, conversationId: conversation.id };
}

const sentFor = (c: {
  tenantId: string;
  conversationId: string;
}): Promise<number> =>
  db.followUp.count({
    where: { tenantId: c.tenantId, conversationId: c.conversationId },
  });

describe('follow-up scheduler', () => {
  it('sends one locale follow-up through the outbound path, never twice', async () => {
    const c = await silentConversation();
    expect(
      await service().scan(NOW, DEFAULT_FOLLOW_UP_POLICY, {
        tenantId: c.tenantId,
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(await sentFor(c)).toBe(1);
    const message = await db.message.findFirstOrThrow({
      where: {
        conversationId: c.conversationId,
        authorType: 'BOT',
        sequence: 3,
      },
    });
    expect(message).toMatchObject({
      text: UZ_LATN.templates.followUp,
      deliveryState: 'PENDING',
      direction: 'OUTBOUND',
    });
    expect(message.text).toContain('/stop');
    expect(
      await db.outboxEvent.count({
        where: {
          tenantId: c.tenantId,
          type: 'telegram.send',
          aggregateId: message.id,
        },
      }),
    ).toBe(1);
    // Later scans (also from a second process, also concurrently) add nothing.
    await Promise.all([
      service().scan(NOW, DEFAULT_FOLLOW_UP_POLICY, { tenantId: c.tenantId }),
      service(other).scan(NOW, DEFAULT_FOLLOW_UP_POLICY, {
        tenantId: c.tenantId,
      }),
    ]);
    await service().scan(
      new Date(NOW.getTime() + 100 * 3_600_000),
      DEFAULT_FOLLOW_UP_POLICY,
    );
    expect(await sentFor(c)).toBe(1);
  });

  it.each([
    ['an opted-out contact', { optOut: true }],
    ['a contact who revoked consent', { consent: 'REVOKED' as const }],
    ['a conversation an operator owns', { state: 'OPERATOR_ACTIVE' as const }],
    ['a customer who wrote last', { lastFrom: 'CUSTOMER' as const }],
    [
      'a bot message that was never delivered',
      { delivered: 'PENDING' as const },
    ],
    ['a conversation where nothing of value was shown', { value: false }],
    ['a conversation that is not silent long enough', { ageHours: 5 }],
  ])('sends nothing for %s', async (_name, over) => {
    const c = await silentConversation(over);
    await service().scan(NOW, DEFAULT_FOLLOW_UP_POLICY, {
      tenantId: c.tenantId,
    });
    expect(await sentFor(c)).toBe(0);
  });

  it('waits out the tenant’s quiet hours instead of skipping the follow-up', async () => {
    const c = await silentConversation();
    const night = new Date('2026-10-26T18:30:00Z'); // 23:30 in Tashkent
    await service().scan(night, DEFAULT_FOLLOW_UP_POLICY, {
      tenantId: c.tenantId,
    });
    expect(await sentFor(c)).toBe(0);
    const morning = new Date('2026-10-27T05:30:00Z'); // 10:30 in Tashkent
    await service().scan(morning, DEFAULT_FOLLOW_UP_POLICY, {
      tenantId: c.tenantId,
    });
    expect(await sentFor(c)).toBe(1);
  });

  it('does nothing unless enabled', async () => {
    const c = await silentConversation();
    expect(await service(db, false).scanDue(NOW)).toBe(0);
    expect(await sentFor(c)).toBe(0);
  });
});

describe('per-tenant allowance', () => {
  it('never sends more than the tenant’s rolling 24-hour cap', async () => {
    const first = await silentConversation();
    // Two more silent conversations of the SAME tenant.
    const account = await db.channelAccount.findFirstOrThrow({
      where: { tenantId: first.tenantId },
    });
    const extra = async (n: number): Promise<string> => {
      const contact = await db.contact.create({
        data: {
          tenantId: first.tenantId,
          channelAccountId: account.id,
          providerUserId: `x-${n}-${randomUUID()}`,
        },
      });
      const conversation = await db.conversation.create({
        data: {
          tenantId: first.tenantId,
          channelAccountId: account.id,
          contactId: contact.id,
          providerChatId: `x-${n}-${randomUUID()}`,
          language: 'uz',
          script: 'Latn',
        },
      });
      const bot = await db.message.create({
        data: {
          tenantId: first.tenantId,
          conversationId: conversation.id,
          channelAccountId: account.id,
          authorType: 'BOT',
          direction: 'OUTBOUND',
          text: 'Variantlar',
          sequence: 1,
          providerChatId: conversation.providerChatId,
          deliveryState: 'SENT',
          createdAt: HOURS(30),
        },
      });
      await db.shownOffer.create({
        data: {
          tenantId: first.tenantId,
          conversationId: conversation.id,
          messageId: bot.id,
          offerRef: 'item:y',
          facts: [],
        },
      });
      return conversation.id;
    };
    await extra(1);
    await extra(2);
    const capped = { ...DEFAULT_FOLLOW_UP_POLICY, maxPerTenantPerDay: 2 };
    await service().scan(NOW, capped, { tenantId: first.tenantId });
    expect(
      await db.followUp.count({ where: { tenantId: first.tenantId } }),
    ).toBe(2);
    await service().scan(NOW, capped, { tenantId: first.tenantId });
    expect(
      await db.followUp.count({ where: { tenantId: first.tenantId } }),
    ).toBe(2);
    // Another day, the allowance is available again.
    await service().scan(
      new Date(NOW.getTime() + 25 * 3_600_000),
      { ...capped, maxPerConversation: 1 },
      { tenantId: first.tenantId },
    );
    expect(
      await db.followUp.count({ where: { tenantId: first.tenantId } }),
    ).toBe(3);
  });
});

describe('a blocked bot ends reminders', () => {
  it('marks the contact when Telegram answers 403', async () => {
    const c = await silentConversation();
    await service().scan(NOW, DEFAULT_FOLLOW_UP_POLICY, {
      tenantId: c.tenantId,
    });
    const message = await db.message.findFirstOrThrow({
      where: { conversationId: c.conversationId, sequence: 3 },
    });
    const sender = {
      sendMessage: vi.fn().mockRejectedValue(new TelegramApiError(403, null)),
    };
    const processor = new TelegramProcessor(
      db as unknown as PrismaService,
      sender as unknown as TelegramSender,
    );
    await processor.process({
      outboxId: randomUUID(),
      tenantId: c.tenantId,
      type: 'telegram.send',
      payload: { messageId: message.id },
    });
    const contact = await db.contact.findFirstOrThrow({
      where: { tenantId: c.tenantId },
    });
    expect(contact.marketingOptOut).toBe(true);
    expect(
      await db.auditEvent.count({
        where: { tenantId: c.tenantId, action: 'telegram.bot_blocked' },
      }),
    ).toBe(1);
    expect(
      (await db.message.findFirstOrThrow({ where: { id: message.id } }))
        .deliveryState,
    ).toBe('FAILED');
  });
});
