import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { HandoverNotificationService } from '../handover/handover-notification.service.js';
import type {
  NotifierTarget,
  OperatorNotifier,
} from '../handover/operator-notifier.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AlertsService, OPERATOR_ALERT_EVENT } from './alerts.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Alert integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SETTINGS: Record<string, unknown> = {
  ALERTS_ENABLED: true,
  ALERT_BUDGET_PERCENT: 80,
  ALERT_CRM_FAILURES_PER_HOUR: 5,
  ALERT_OUTBOX_BACKLOG_MINUTES: 10,
  ALERT_FAILED_TURNS_PER_HOUR: 3,
  LLM_TENANT_MONTHLY_BUDGET_USD: '1',
};
const alerts = (overrides: Record<string, unknown> = {}): AlertsService =>
  new AlertsService(prisma, {
    get: (key: string) => ({ ...SETTINGS, ...overrides })[key],
  } as unknown as ConfigService<AppEnvironment, true>);

// Far in the future, so rows that other tests left in the shared test
// database fall outside every window used here.
const NOW = new Date('2031-03-15T10:30:00.000Z');
const minutesAgo = (minutes: number): Date =>
  new Date(NOW.getTime() - minutes * 60_000);

interface Fixture {
  tenantId: string;
  accountId: string;
  contactId: string;
  conversationId: string;
}

async function tenant(
  options: { withChat?: boolean; locale?: string } = {},
): Promise<Fixture> {
  const suffix = randomUUID();
  const locale = options.locale ?? 'en';
  const t = await db.tenant.create({
    data: {
      slug: `al-${suffix}`,
      name: 'Alert fixture',
      defaultLocale: locale,
      supportedLocales: [locale],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `al-${suffix}`,
      status: 'ACTIVE',
      operatorChatId: options.withChat === false ? null : '-100777',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Alert contact',
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
    accountId: account.id,
    contactId: contact.id,
    conversationId: conversation.id,
  };
}

async function spend(f: Fixture, costNano: bigint, at: Date): Promise<void> {
  await db.llmUsageRecord.create({
    data: {
      tenantId: f.tenantId,
      turnKey: randomUUID(),
      callIndex: 0,
      purpose: 'reply',
      tier: 'FAST',
      provider: 'mock',
      model: 'mock',
      responseId: randomUUID(),
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      costNano,
      reservedNano: costNano,
      pricingVersion: 'test',
      durationMs: 1,
      attempts: 1,
      outcome: 'OK',
      createdAt: at,
    },
  });
}

async function failedLeads(f: Fixture, count: number, at: Date): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const conversation = await db.conversation.create({
      data: {
        tenantId: f.tenantId,
        channelAccountId: f.accountId,
        contactId: f.contactId,
        providerChatId: `c-${randomUUID()}`,
      },
    });
    await db.lead.create({
      data: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        conversationId: conversation.id,
        summary: 'Synthetic lead',
        idempotencyKey: randomUUID(),
        crmSyncStatus: 'FAILED',
        updatedAt: at,
      },
    });
  }
}

const queuedAlerts = (tenantId: string): Promise<unknown[]> =>
  db.outboxEvent
    .findMany({
      where: { tenantId, type: OPERATOR_ALERT_EVENT },
      orderBy: { createdAt: 'asc' },
      select: { payload: true, idempotencyKey: true },
    })
    .then((rows) => rows.map((row) => row.payload));

describe('operator alerts (fixed clock)', () => {
  it('queues the budget alert once per UTC month when spend reaches the threshold', async () => {
    const f = await tenant();
    await spend(f, 790_000_000n, minutesAgo(60)); // 79% of $1
    await alerts().scanDue(NOW);
    expect(await queuedAlerts(f.tenantId)).toEqual([]);

    await spend(f, 60_000_000n, minutesAgo(5)); // 85%
    await Promise.all([alerts().scanDue(NOW), alerts().scanDue(NOW)]);
    await alerts().scanDue(new Date('2031-03-31T23:00:00Z'));
    expect(await queuedAlerts(f.tenantId)).toEqual([
      { kind: 'BUDGET_NEAR_LIMIT', percent: 85, month: '2031-03' },
    ]);

    // A new month starts from zero.
    await alerts().scanDue(new Date('2031-04-01T00:10:00Z'));
    expect(await queuedAlerts(f.tenantId)).toHaveLength(1);
    await spend(f, 900_000_000n, new Date('2031-04-02T08:00:00Z'));
    await alerts().scanDue(new Date('2031-04-02T09:00:00Z'));
    expect(await queuedAlerts(f.tenantId)).toEqual([
      expect.objectContaining({ month: '2031-03' }),
      { kind: 'BUDGET_NEAR_LIMIT', percent: 90, month: '2031-04' },
    ]);
  });

  it('queues the CRM failure alert once per hour from the threshold, per tenant', async () => {
    const a = await tenant();
    const b = await tenant();
    await failedLeads(a, 4, minutesAgo(10));
    await failedLeads(a, 3, minutesAgo(90)); // outside the hour
    await failedLeads(b, 5, minutesAgo(20));
    await alerts().scanDue(NOW);
    expect(await queuedAlerts(a.tenantId)).toEqual([]);
    expect(await queuedAlerts(b.tenantId)).toEqual([
      { kind: 'CRM_SYNC_FAILURES', count: 5 },
    ]);

    await failedLeads(a, 1, minutesAgo(1));
    await alerts().scanDue(NOW);
    await alerts().scanDue(new Date(NOW.getTime() + 60_000));
    expect(await queuedAlerts(a.tenantId)).toEqual([
      { kind: 'CRM_SYNC_FAILURES', count: 5 },
    ]);
  });

  it('does nothing when disabled, without a budget, or without an operator group', async () => {
    const f = await tenant();
    const noChat = await tenant({ withChat: false });
    for (const t of [f, noChat]) {
      await spend(t, 950_000_000n, minutesAgo(5));
      await failedLeads(t, 6, minutesAgo(5));
    }
    await alerts({ ALERTS_ENABLED: false }).scanDue(NOW);
    expect(await queuedAlerts(f.tenantId)).toEqual([]);
    await alerts({ LLM_TENANT_MONTHLY_BUDGET_USD: undefined }).scanDue(NOW);
    expect(await queuedAlerts(f.tenantId)).toEqual([
      { kind: 'CRM_SYNC_FAILURES', count: 6 },
    ]);
    await alerts().scanDue(NOW);
    expect(await queuedAlerts(noChat.tenantId)).toEqual([]);
  });

  it('delivers an alert to the operator group in the tenant language', async () => {
    const posted: { target: NotifierTarget; text: string }[] = [];
    const notifier = {
      kind: 'fake',
      postCard: (target: NotifierTarget, card: { text: string }) => {
        posted.push({ target, text: card.text });
        return Promise.resolve({ messageId: '1' });
      },
    } as unknown as OperatorNotifier;
    const service = new HandoverNotificationService(prisma, notifier);
    const en = await tenant();
    const ru = await tenant({ locale: 'ru' });
    await service.process({
      outboxId: randomUUID(),
      tenantId: en.tenantId,
      type: OPERATOR_ALERT_EVENT,
      payload: { kind: 'BUDGET_NEAR_LIMIT', percent: 85, month: '2031-03' },
    } as never);
    await service.process({
      outboxId: randomUUID(),
      tenantId: ru.tenantId,
      type: OPERATOR_ALERT_EVENT,
      payload: { kind: 'CRM_SYNC_FAILURES', count: 7 },
    } as never);
    await service.process({
      outboxId: randomUUID(),
      tenantId: en.tenantId,
      type: OPERATOR_ALERT_EVENT,
      payload: { kind: 'SOMETHING_ELSE' },
    } as never);
    expect(posted).toEqual([
      {
        target: { operatorChatId: '-100777', channelAccountId: en.accountId },
        text: 'Alert: 85% of the monthly AI budget is used (2031-03)',
      },
      {
        target: { operatorChatId: '-100777', channelAccountId: ru.accountId },
        text: 'Внимание: 7 лидов не удалось передать в CRM за последний час',
      },
    ]);
  });
});

describe('platform alerts (log lines, fixed clock)', () => {
  // These counts are platform-wide, so each run uses its own hour: rows an
  // earlier run left in the shared test database never fall in its window.
  const P_NOW = new Date(
    Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 500_000) * 3_600_000,
  );
  const pAgo = (minutes: number): Date =>
    new Date(P_NOW.getTime() - minutes * 60_000);

  it('logs failed turns once per hour from the threshold', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((message) => {
      lines.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = await tenant();
    const turn = (minutes: number): Promise<unknown> =>
      db.agentTurn.create({
        data: {
          tenantId: f.tenantId,
          conversationId: f.conversationId,
          channelAccountId: f.accountId,
          idempotencyKey: randomUUID(),
          attempt: 1,
          mode: 'SHADOW',
          claimToken: randomUUID(),
          leaseExpiresAt: pAgo(minutes),
          answeredSequence: 1,
          seenInboundSequence: 1,
          conversationVersion: 0,
          correlationId: randomUUID(),
          status: 'FAILED',
          completedAt: pAgo(minutes),
        },
      });
    await turn(10);
    await turn(20);
    await turn(70); // outside the hour
    const service = alerts();
    await service.scanDue(P_NOW);
    expect(lines.filter((l) => l.includes('alert.failed_turns'))).toEqual([]);
    await turn(5);
    await service.scanDue(P_NOW);
    await service.scanDue(new Date(P_NOW.getTime() + 60_000));
    expect(lines.filter((l) => l.includes('alert.failed_turns'))).toEqual([
      JSON.stringify({ event: 'alert.failed_turns', failedLastHour: 3 }),
    ]);
  });

  it('logs an outbox backlog once per hour and nothing when no event waits too long', async () => {
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      warnings.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const f = await tenant();
    await db.outboxEvent.create({
      data: {
        tenantId: f.tenantId,
        type: 'test.backlog',
        aggregateType: 'tenant',
        aggregateId: f.tenantId,
        idempotencyKey: randomUUID(),
        payload: {},
        status: 'PENDING',
        availableAt: pAgo(25),
      },
    });
    const service = alerts();
    await service.scanDue(P_NOW);
    await service.scanDue(P_NOW);
    const backlog = warnings.filter((w) => w.includes('alert.outbox_backlog'));
    expect(backlog).toHaveLength(1);
    expect(JSON.parse(backlog[0]!)).toMatchObject({
      event: 'alert.outbox_backlog',
    });
    expect(
      (JSON.parse(backlog[0]!) as { oldestMinutes: number }).oldestMinutes,
    ).toBeGreaterThanOrEqual(25);

    // Long before any row existed: nothing waits, nothing is logged.
    warnings.length = 0;
    await alerts().scanDue(new Date('2000-01-01T00:00:00Z'));
    expect(warnings.filter((w) => w.includes('alert.outbox_backlog'))).toEqual(
      [],
    );
  });
});
