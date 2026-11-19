import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OPERATOR_ALERT_EVENT } from '../observability/alerts.service.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import type { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import { appClient, ownerClient } from '../persistence/testing/test-clients.js';
import { countNewLeadsThisMonth } from './lead-limit.js';
import { LeadLimitScanService } from './lead-limit-scan.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Lead limit tests require agentcore_test');
}
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
const privileged = { db } as PrivilegedDatabase;
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

// Far in the future so leads other specs created never count.
const NOW = new Date('2041-06-20T09:00:00.000Z');
const IN_MONTH = new Date('2041-06-05T09:00:00.000Z');
const LAST_MONTH = new Date('2041-05-30T09:00:00.000Z');

async function tenant(
  limit: number | null,
  zone = 'UTC',
): Promise<{ tenantId: string; accountId: string; contactId: string }> {
  const suffix = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `ll-${suffix}`,
      name: 'Lead limit fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: zone,
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `ll-${suffix}`,
      status: 'ACTIVE',
      operatorChatId: '-100888',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Fixture',
    },
  });
  const plan = await db.subscriptionPlan.create({
    data: {
      code: `ll-${suffix}`,
      name: 'Limit plan',
      priceMinor: 1n,
      periodDays: 30,
      limits: limit === null ? {} : { monthlyNewLeads: limit },
    },
  });
  await db.tenantSubscription.create({
    data: {
      tenantId: t.id,
      planId: plan.id,
      status: 'ACTIVE',
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date(NOW.getTime() + 30 * 86_400_000),
    },
  });
  return { tenantId: t.id, accountId: account.id, contactId: contact.id };
}

async function leads(
  f: { tenantId: string; accountId: string; contactId: string },
  count: number,
  at: Date,
): Promise<void> {
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
        createdAt: at,
      },
    });
  }
}

const alerts = (tenantId: string): Promise<Record<string, unknown>[]> =>
  db.outboxEvent
    .findMany({
      where: { tenantId, type: OPERATOR_ALERT_EVENT },
      orderBy: { createdAt: 'asc' },
      select: { payload: true },
    })
    .then((rows) => rows.map((row) => row.payload as Record<string, unknown>));

describe('lead limit warnings (ADR 080)', () => {
  it('counts only this month and only the tenant', async () => {
    const a = await tenant(10);
    const b = await tenant(10);
    await leads(a, 2, IN_MONTH);
    await leads(a, 3, LAST_MONTH);
    await leads(b, 4, IN_MONTH);
    const count = (id: string): Promise<number> =>
      runWithTenant(id, () => countNewLeadsThisMonth(prisma, id, 'UTC', NOW));
    expect(await count(a.tenantId)).toBe(2);
    expect(await count(b.tenantId)).toBe(4);
  });

  it('sends one message per threshold and month, per tenant', async () => {
    const a = await tenant(10);
    const b = await tenant(10);
    const none = await tenant(null);
    await leads(a, 8, IN_MONTH);
    await leads(b, 7, IN_MONTH);
    await leads(none, 50, IN_MONTH);
    const scan = (): LeadLimitScanService =>
      new LeadLimitScanService(prisma, privileged);

    await scan().scanDue(NOW);
    // A second process / a repeated scan sends nothing more.
    await scan().scanDue(new Date(NOW.getTime() + 7 * 3_600_000));
    expect(await alerts(a.tenantId)).toEqual([
      {
        kind: 'LEAD_LIMIT',
        percent: 80,
        count: 8,
        limit: 10,
        month: '2041-06',
      },
    ]);
    expect(await alerts(b.tenantId)).toEqual([]);
    expect(await alerts(none.tenantId)).toEqual([]);

    // Crossing 100 % later sends the second message, once.
    await leads(a, 2, IN_MONTH);
    await scan().scanDue(new Date(NOW.getTime() + 14 * 3_600_000));
    await scan().scanDue(new Date(NOW.getTime() + 21 * 3_600_000));
    const sent = await alerts(a.tenantId);
    expect(sent.map((p) => p.percent)).toEqual([80, 100]);

    // The next month starts a fresh round.
    await scan().scanDue(new Date('2041-07-01T09:00:00Z'));
    expect(await alerts(a.tenantId)).toHaveLength(2);
  });

  it('throttles a process to one scan per interval', async () => {
    const service = new LeadLimitScanService(prisma, privileged);
    const f = await tenant(2);
    await leads(f, 2, IN_MONTH);
    expect(await service.scanDue(NOW)).toBeGreaterThanOrEqual(1);
    expect(await service.scanDue(new Date(NOW.getTime() + 60_000))).toBe(0);
  });
});
