import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { normalizeTelegramUpdate } from '../channels/telegram/telegram-normalizer.js';
import {
  TelegramProcessor,
  type TelegramQueueEvent,
} from '../channels/telegram/telegram-processor.js';
import type { TelegramSender } from '../channels/telegram/telegram-sender.js';
import type { TelegramAgentPipeline } from '../channels/telegram/telegram-agent-pipeline.js';
import { TelegramWebhookService } from '../channels/telegram/telegram-webhook.service.js';
import { retireOutbox } from '../channels/telegram/testing/outbox.js';
import {
  BOT_PAUSED_EVENT,
  INBOUND_BLOCKED_ACTION,
  InboundAccessGate,
} from './inbound-access-gate.js';
import {
  EXPIRED_EVENT,
  PAST_DUE_EVENT,
  SubscriptionScanService,
} from './subscription-scan.service.js';
import { TenantAccessService } from './tenant-access.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Access enforcement tests require agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
const tenants: string[] = [];
afterAll(async () => {
  await retireOutbox(db, tenants);
  await db.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;

function config(
  values: Record<string, unknown>,
): ConfigService<AppEnvironment, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    AppEnvironment,
    true
  >;
}

interface World {
  tenantId: string;
  accountId: string;
  webhook: TelegramWebhookService;
  processor: TelegramProcessor;
  agentProcessor: TelegramProcessor;
  run: ReturnType<typeof vi.fn>;
  access: TenantAccessService;
}

async function plan(): Promise<string> {
  const row = await db.subscriptionPlan.create({
    data: {
      code: `it-${randomUUID().slice(0, 12)}`,
      name: 'Integration plan',
      priceMinor: 100n,
      periodDays: 30,
    },
  });
  return row.id;
}

async function world(
  options: { billingRequired?: boolean } = {},
): Promise<World> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `access-${suffix}`,
      name: 'Access fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
      config: options.billingRequired ? { billing: { required: true } } : {},
    },
  });
  tenants.push(tenant.id);
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `access-${suffix}`,
      status: 'ACTIVE',
      agentMode: 'OFF',
    },
  });
  const access = new TenantAccessService(prisma);
  const gate = new InboundAccessGate(prisma, access);
  const sender = { sendMessage: vi.fn() } as unknown as TelegramSender;
  const run = vi.fn(async () => undefined);
  const agent = {
    modeFor: vi.fn(async () => 'LIVE'),
    run,
    failOwnedTurns: vi.fn(async () => undefined),
  } as unknown as TelegramAgentPipeline;
  const optional = [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ] as const;
  return {
    tenantId: tenant.id,
    accountId: account.id,
    access,
    run,
    webhook: new TelegramWebhookService(
      prisma,
      config({
        TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
        TELEGRAM_WEBHOOK_SECRET: 'integration-secret',
        TELEGRAM_RATE_LIMIT_PER_MINUTE: 1_000,
      }),
    ),
    // Agent OFF: the Phase 2 echo path.
    processor: new TelegramProcessor(
      prisma,
      sender,
      undefined,
      ...optional,
      gate,
    ),
    // A stub agent: records whether a turn would have started.
    agentProcessor: new TelegramProcessor(
      prisma,
      sender,
      agent,
      ...optional,
      gate,
    ),
  };
}

let nextUpdate = 910_000 + Math.floor(Math.random() * 50_000);
async function receive(w: World, text: string): Promise<TelegramQueueEvent> {
  const updateId = ++nextUpdate;
  const normalized = normalizeTelegramUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: 5_151 },
      from: { id: 88 },
      text,
    },
  });
  if (normalized.kind !== 'text') throw new Error('expected text');
  expect(await w.webhook.accept(w.accountId, normalized)).toBe('accepted');
  const outbox = await db.outboxEvent.findFirstOrThrow({
    where: {
      tenantId: w.tenantId,
      type: 'telegram.inbound',
      idempotencyKey: `telegram.inbound:${w.accountId}:${updateId}`,
    },
  });
  return {
    outboxId: outbox.id,
    tenantId: w.tenantId,
    type: outbox.type,
    payload: outbox.payload,
  };
}

const outbound = (w: World): Promise<number> =>
  db.message.count({ where: { tenantId: w.tenantId, direction: 'OUTBOUND' } });

describe('inbound processing under ADR 047 access rules', () => {
  it('an active tenant without billing answers as before (echo and agent)', async () => {
    const w = await world();
    await w.processor.process(await receive(w, 'salom'));
    expect(await outbound(w)).toBe(1);
    await w.agentProcessor.process(await receive(w, 'yana'));
    expect(w.run).toHaveBeenCalledTimes(1);
  });

  it('a tenant suspended after the webhook stored its messages gets no turn and no reply, one audit a day', async () => {
    // The webhooks already refuse new updates for a non-ACTIVE tenant; this
    // covers what was queued before the suspension (and the cache window).
    const w = await world();
    const first = await receive(w, 'salom');
    const second = await receive(w, 'hello?');
    await db.tenant.update({
      where: { id: w.tenantId },
      data: { status: 'SUSPENDED' },
    });
    await w.processor.process(first);
    await w.agentProcessor.process(second);
    expect(w.run).not.toHaveBeenCalled();
    expect(await outbound(w)).toBe(0);
    expect(
      await db.message.count({
        where: { tenantId: w.tenantId, direction: 'INBOUND' },
      }),
    ).toBe(2);
    expect(
      await db.inboundEvent.count({
        where: { tenantId: w.tenantId, status: 'PROCESSED' },
      }),
    ).toBe(2);
    const audits = await db.auditEvent.findMany({
      where: { tenantId: w.tenantId, action: INBOUND_BLOCKED_ACTION },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'SYSTEM',
      entityId: w.tenantId,
    });
  });

  it('an expired subscription silences the bot and tells operators', async () => {
    const w = await world({ billingRequired: true });
    const event = await receive(w, 'salom');
    const conversationId = (event.payload as { conversationId: string })
      .conversationId;
    const before = await db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    await w.agentProcessor.process(event);
    await w.processor.process(await receive(w, 'yana'));
    expect(w.run).not.toHaveBeenCalled();
    expect(await outbound(w)).toBe(0);
    const paused = await db.inboxEvent.findMany({
      where: { tenantId: w.tenantId, type: BOT_PAUSED_EVENT },
    });
    expect(paused).toHaveLength(2);
    expect(paused[0]?.conversationId).toBe(conversationId);
    const after = await db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(after.state).toBe(before.state);
    expect(
      await db.auditEvent.count({
        where: { tenantId: w.tenantId, action: INBOUND_BLOCKED_ACTION },
      }),
    ).toBe(0);
  });

  it('caches the answer for 60 seconds per tenant', async () => {
    const w = await world();
    const now = new Date();
    expect((await w.access.check(w.tenantId, now)).state).toBe('ok');
    await db.tenant.update({
      where: { id: w.tenantId },
      data: { status: 'ARCHIVED' },
    });
    expect(
      (await w.access.check(w.tenantId, new Date(now.getTime() + 59_000)))
        .state,
    ).toBe('ok');
    expect(
      (await w.access.check(w.tenantId, new Date(now.getTime() + 61_000)))
        .state,
    ).toBe('ARCHIVED');
  });
});

describe('subscription scan on the real database (fake clock)', () => {
  it('ACTIVE -> PAST_DUE -> EXPIRED with audit and inbox events, idempotently', async () => {
    const w = await world({ billingRequired: true });
    const start = new Date(Date.UTC(2031, 0, 1));
    const end = new Date(start.getTime() + 30 * DAY);
    const subscription = await db.tenantSubscription.create({
      data: {
        tenantId: w.tenantId,
        planId: await plan(),
        status: 'ACTIVE',
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    });
    const scan = new SubscriptionScanService(
      prisma,
      config({ SUBSCRIPTION_GRACE_DAYS: 3 }),
      w.access,
    );
    const at = (days: number): Date => new Date(end.getTime() + days * DAY);
    expect((await w.access.check(w.tenantId, at(-1))).state).toBe('ok');

    await scan.scanDue(at(1));
    await scan.scanDue(at(1));
    let row = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(row.status).toBe('PAST_DUE');
    expect(row.graceUntil).toEqual(at(3));
    expect((await w.access.check(w.tenantId, at(1))).state).toBe('ok');

    await scan.scanDue(at(4));
    await scan.scanDue(at(5));
    row = await db.tenantSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(row.status).toBe('EXPIRED');
    expect((await w.access.check(w.tenantId, at(4))).state).toBe(
      'SUBSCRIPTION_EXPIRED',
    );

    const audits = await db.platformAuditEvent.findMany({
      where: { tenantId: w.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'subscription.past_due',
      'subscription.expired',
    ]);
    expect(audits.every((a) => a.actorAdminId === null)).toBe(true);
    const events = await db.inboxEvent.findMany({
      where: {
        tenantId: w.tenantId,
        type: { in: [PAST_DUE_EVENT, EXPIRED_EVENT] },
      },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual([PAST_DUE_EVENT, EXPIRED_EVENT]);
  });

  it('allows only one open subscription per tenant (partial unique index)', async () => {
    const w = await world();
    const planId = await plan();
    const now = new Date();
    const open = {
      tenantId: w.tenantId,
      planId,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + DAY),
    };
    await db.tenantSubscription.create({ data: { ...open, status: 'TRIAL' } });
    await expect(
      db.tenantSubscription.create({ data: { ...open, status: 'ACTIVE' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Closed rows do not count.
    await db.tenantSubscription.create({
      data: { ...open, status: 'EXPIRED' },
    });
    await db.tenantSubscription.create({
      data: { ...open, status: 'CANCELED' },
    });
  });
});
