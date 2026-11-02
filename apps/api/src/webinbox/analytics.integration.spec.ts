import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Analytics tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

/**
 * Sets a timestamp with an explicit-offset literal. Dates handed to Prisma are
 * read in the database session's time zone by the pg adapter, which shifts
 * them on a machine whose Postgres is not on UTC; a literal with 'Z' is exact
 * everywhere, so the expected numbers do not depend on the machine.
 */
async function stamp(
  table: 'conversations' | 'messages' | 'handovers' | 'leads' | 'agent_turns',
  column: 'created_at' | 'opened_at' | 'taken_at' | 'sla_alerted_at',
  id: string,
  iso: string,
): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE ${table} SET ${column} = $1::timestamptz WHERE id = $2::uuid`,
    iso,
    id,
  );
}
const plus = (iso: string, seconds: number): string =>
  new Date(new Date(iso).getTime() + seconds * 1000).toISOString();

interface Tenant {
  id: string;
  accountId: string;
}

async function tenant(timezone = 'UTC'): Promise<Tenant> {
  const suffix = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `an-${suffix}`,
      name: 'Analytics fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone,
      packKey: 'education',
      packVersion: '1',
    },
  });
  const a = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `an-${suffix}`,
      status: 'ACTIVE',
    },
  });
  return { id: t.id, accountId: a.id };
}

/** One conversation with its first customer message and an optional first reply. */
async function conversation(
  t: Tenant,
  options: {
    created: string;
    language: string | null;
    replyAfterSeconds?: number;
    replyBy?: 'BOT' | 'OPERATOR';
    confidence?: number;
  },
): Promise<string> {
  const suffix = randomUUID();
  const contact = await db.contact.create({
    data: {
      tenantId: t.id,
      channelAccountId: t.accountId,
      providerUserId: `u-${suffix}`,
      name: 'Customer',
    },
  });
  const c = await db.conversation.create({
    data: {
      tenantId: t.id,
      channelAccountId: t.accountId,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      language: options.language,
    },
  });
  await stamp('conversations', 'created_at', c.id, options.created);
  const inbound = await db.message.create({
    data: {
      tenantId: t.id,
      conversationId: c.id,
      channelAccountId: t.accountId,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      text: 'private customer words',
      sequence: 1,
      providerChatId: `c-${suffix}`,
      ...(options.confidence !== undefined
        ? { languageConfidence: options.confidence }
        : {}),
    },
  });
  await stamp('messages', 'created_at', inbound.id, options.created);
  if (options.replyAfterSeconds !== undefined) {
    const reply = await db.message.create({
      data: {
        tenantId: t.id,
        conversationId: c.id,
        channelAccountId: t.accountId,
        authorType: options.replyBy ?? 'BOT',
        direction: 'OUTBOUND',
        text: 'reply',
        sequence: 2,
        providerChatId: `c-${suffix}`,
      },
    });
    await stamp(
      'messages',
      'created_at',
      reply.id,
      plus(options.created, options.replyAfterSeconds),
    );
  }
  return c.id;
}

async function handover(
  t: Tenant,
  conversationId: string,
  reason: string,
  opened: string,
  extra: { takenAfterSeconds?: number; slaAlerted?: boolean } = {},
): Promise<void> {
  const h = await db.handover.create({
    data: {
      tenantId: t.id,
      conversationId,
      reasonCode: reason,
      summary: {},
      idempotencyKey: `h-${randomUUID()}`,
    },
  });
  await stamp('handovers', 'opened_at', h.id, opened);
  if (extra.takenAfterSeconds !== undefined)
    await stamp(
      'handovers',
      'taken_at',
      h.id,
      plus(opened, extra.takenAfterSeconds),
    );
  if (extra.slaAlerted)
    await stamp('handovers', 'sla_alerted_at', h.id, opened);
}

async function lead(
  t: Tenant,
  conversationId: string,
  score: 'HOT' | 'WARM' | 'COLD',
  crm: 'PENDING' | 'SYNCED' | 'FAILED',
  created: string,
): Promise<void> {
  const conv = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
  });
  const created_lead = await db.lead.create({
    data: {
      tenantId: t.id,
      contactId: conv.contactId,
      conversationId,
      score,
      summary: 's',
      crmSyncStatus: crm,
      idempotencyKey: `l-${randomUUID()}`,
    },
  });
  await stamp('leads', 'created_at', created_lead.id, created);
}

async function turn(
  t: Tenant,
  conversationId: string,
  options: {
    created: string;
    outcome: string;
    latencyMs: number;
    costNano: bigint;
    violations?: string[];
    handoverReason?: string;
    tools?: { name: string; status: string }[];
    status?: 'COMMITTED' | 'DISCARDED';
  },
): Promise<void> {
  const row = await db.agentTurn.create({
    data: {
      tenantId: t.id,
      conversationId,
      channelAccountId: t.accountId,
      idempotencyKey: `t-${randomUUID()}`,
      attempt: 1,
      mode: 'LIVE',
      status: options.status ?? 'COMMITTED',
      claimToken: 'x',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      answeredSequence: 1,
      seenInboundSequence: 1,
      conversationVersion: 1,
      inboundEventIds: [],
      correlationId: 'c',
      outcome: options.outcome,
      handoverReason: options.handoverReason ?? null,
      latencyMs: options.latencyMs,
      actualCostNano: options.costNano,
      inputTokens: 100,
      outputTokens: 10,
      guardrail: { violations: options.violations ?? [], regenerated: false },
      toolCalls: options.tools ?? [],
    },
  });
  await stamp('agent_turns', 'created_at', row.id, options.created);
}

const principal = (tenantId: string, role: string): never =>
  ({
    principal: { tenantId, operatorId: randomUUID(), role, sessionId: 's' },
  }) as never;

describe('analytics report', () => {
  it("computes every Section 11 metric from the tenant's rows, for the chosen days only", async () => {
    const t = await tenant('UTC');
    const other = await tenant('UTC');
    // Day 1: three conversations. Replies after 4 s (bot), 10 s (bot), 100 s (operator).
    const c1 = await conversation(t, {
      created: '2026-03-01T10:00:00Z',
      language: 'uz',
      replyAfterSeconds: 4,
      confidence: 0.9,
    });
    const c2 = await conversation(t, {
      created: '2026-03-01T11:00:00Z',
      language: 'uz',
      replyAfterSeconds: 10,
      confidence: 0.3,
    });
    const c3 = await conversation(t, {
      created: '2026-03-01T12:00:00Z',
      language: 'ru',
      replyAfterSeconds: 100,
      replyBy: 'OPERATOR',
    });
    // Day 2: one with no reply yet and no language, one answered by the bot.
    await conversation(t, { created: '2026-03-02T09:00:00Z', language: null });
    const c5 = await conversation(t, {
      created: '2026-03-02T09:30:00Z',
      language: 'en',
      replyAfterSeconds: 6,
    });
    // Outside the range, and another tenant: never counted.
    await conversation(t, {
      created: '2026-02-20T09:00:00Z',
      language: 'uz',
      replyAfterSeconds: 1,
    });
    await conversation(other, {
      created: '2026-03-01T10:00:00Z',
      language: 'uz',
      replyAfterSeconds: 1,
    });

    await handover(t, c3, 'CUSTOMER_REQUEST', '2026-03-01T12:01:00Z', {
      takenAfterSeconds: 60,
      slaAlerted: true,
    });
    await handover(t, c2, 'NO_DATA', '2026-03-01T11:02:00Z', {
      takenAfterSeconds: 120,
    });
    await handover(t, c5, 'GUARDRAIL', '2026-03-02T09:31:00Z');
    await lead(t, c1, 'HOT', 'SYNCED', '2026-03-01T10:05:00Z');
    await lead(t, c2, 'COLD', 'FAILED', '2026-03-01T11:05:00Z');
    await lead(t, c3, 'HOT', 'PENDING', '2026-03-01T12:05:00Z');

    await turn(t, c1, {
      created: '2026-03-01T10:00:01Z',
      outcome: 'ANSWERED',
      latencyMs: 1000,
      costNano: 1_000_000n,
      tools: [
        { name: 'a', status: 'ok' },
        { name: 'b', status: 'ok' },
      ],
    });
    await turn(t, c2, {
      created: '2026-03-01T11:00:01Z',
      outcome: 'ANSWERED',
      latencyMs: 3000,
      costNano: 3_000_000n,
      violations: ['FACT_NOT_LIVE'],
      tools: [{ name: 'a', status: 'error' }],
    });
    await turn(t, c5, {
      created: '2026-03-02T09:30:01Z',
      outcome: 'HANDOVER',
      latencyMs: 2000,
      costNano: 2_000_000n,
      handoverReason: 'GUARDRAIL',
      violations: ['UNSOURCED_NUMBER'],
    });
    await turn(t, c1, {
      created: '2026-03-01T10:00:02Z',
      outcome: 'ANSWERED',
      latencyMs: 9999,
      costNano: 9_999_000_000n,
      status: 'DISCARDED',
    });

    const report = await new AnalyticsService(prisma).report(t.id, {
      from: '2026-03-01',
      to: '2026-03-02',
    });
    expect(report.range).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-02',
      timezone: 'UTC',
      days: 2,
    });
    expect(report.conversations.total).toBe(5);
    expect(report.conversations.byLanguage).toEqual([
      { language: 'uz', count: 2 },
      { language: 'en', count: 1 },
      { language: 'ru', count: 1 },
      { language: 'unknown', count: 1 },
    ]);
    expect(report.conversations.daily).toEqual([
      { day: '2026-03-01', count: 3 },
      { day: '2026-03-02', count: 2 },
    ]);
    // first responses 4, 6, 10 and 100 s: p50 = 8 s, p95 = 10 + 0.85 * 90 = 86.5 s.
    expect(report.firstResponse).toMatchObject({ asked: 5, answered: 4 });
    expect(report.firstResponse.p50Seconds).toBeCloseTo(8, 5);
    expect(report.firstResponse.p95Seconds).toBeCloseTo(86.5, 5);
    expect(report.resolution).toMatchObject({
      total: 5,
      handedOver: 3,
      autoResolved: 1,
    });
    expect(report.resolution.autoResolvedRate).toBeCloseTo(0.2);
    expect(report.resolution.handoverRate).toBeCloseTo(0.6);
    expect(report.handovers.total).toBe(3);
    expect(report.handovers.byReason.map((r) => r.reason).sort()).toEqual([
      'CUSTOMER_REQUEST',
      'GUARDRAIL',
      'NO_DATA',
    ]);
    expect(report.handovers.daily.map((d) => d.count)).toEqual([2, 1]);
    expect(report.handovers.takeOverP50Seconds).toBeCloseTo(90);
    expect(report.handovers.slaAlerted).toBe(1);
    expect(report.leads).toMatchObject({
      total: 3,
      crmFailed: 1,
      crmPending: 1,
    });
    expect(report.leads.byScore).toEqual([
      { score: 'HOT', count: 2 },
      { score: 'WARM', count: 0 },
      { score: 'COLD', count: 1 },
    ]);
    expect(report.leads.captureRate).toBeCloseTo(0.6);
    // Only committed turns count: the discarded one (9999 ms, 9.999 USD) is ignored.
    expect(report.guardrail).toMatchObject({
      turns: 3,
      blockedTurns: 2,
      guardrailHandovers: 1,
    });
    expect(report.guardrail.blockRate).toBeCloseTo(2 / 3);
    expect(report.latency).toMatchObject({ turns: 3, p50Ms: 2000 });
    expect(report.cost.conversationsWithTurns).toBe(3);
    expect(report.cost.totalUsd).toBeCloseTo(0.006);
    expect(report.cost.perConversationUsd).toBeCloseTo(0.002);
    expect(report.cost).toMatchObject({ inputTokens: 300, outputTokens: 30 });
    expect(report.tools).toMatchObject({ calls: 3, errors: 1 });
    expect(report.tools.errorRate).toBeCloseTo(1 / 3);
    expect(report.languageDetection).toMatchObject({
      messages: 2,
      lowConfidence: 1,
    });
    expect(report.languageDetection.averageConfidence).toBeCloseTo(0.6);
    // No customer text anywhere in the report.
    expect(JSON.stringify(report)).not.toContain('private customer words');
  });

  it('gives null rates (not zero) when there is nothing to divide by, and counts days in the tenant time zone', async () => {
    const t = await tenant('Asia/Tashkent');
    // 22:00 UTC on 3 March is 03:00 on 4 March in Tashkent (UTC+5).
    await conversation(t, {
      created: '2026-03-03T22:00:00Z',
      language: 'uz',
      replyAfterSeconds: 5,
    });
    const empty = await new AnalyticsService(prisma).report(t.id, {
      from: '2026-03-01',
      to: '2026-03-02',
    });
    expect(empty.conversations.total).toBe(0);
    expect(empty).toMatchObject({
      firstResponse: { p50Seconds: null, p95Seconds: null },
      resolution: { autoResolvedRate: null, handoverRate: null },
      leads: { captureRate: null },
      guardrail: { blockRate: null },
      cost: { perConversationUsd: null, totalUsd: 0 },
      tools: { errorRate: null },
    });
    const day = await new AnalyticsService(prisma).report(t.id, {
      from: '2026-03-04',
      to: '2026-03-04',
    });
    expect(day.conversations.total).toBe(1);
    const before = await new AnalyticsService(prisma).report(t.id, {
      from: '2026-03-03',
      to: '2026-03-03',
    });
    expect(before.conversations.total).toBe(0);
  });

  it('refuses a reversed, malformed or oversized range', async () => {
    const t = await tenant();
    const service = new AnalyticsService(prisma);
    for (const range of [
      { from: '2026-03-05', to: '2026-03-01' },
      { from: '2026-03-01', to: '2027-06-01' },
      { from: 'yesterday', to: '2026-03-01' },
    ])
      await expect(service.report(t.id, range)).rejects.toThrow();
  });
});

describe('analytics access', () => {
  it('is for owners and admins only, and a bad query is a 400', async () => {
    const t = await tenant();
    const controller = new AnalyticsController(new AnalyticsService(prisma));
    for (const role of ['OPERATOR', 'VIEWER'])
      await expect(
        controller.report(principal(t.id, role), {}),
      ).rejects.toMatchObject({
        response: { code: 'FORBIDDEN' },
      });
    await expect(
      controller.report(principal(t.id, 'ADMIN'), {}),
    ).resolves.toMatchObject({
      range: { days: 30 },
    });
    await expect(
      controller.report(principal(t.id, 'OWNER'), { from: 'x' }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_QUERY' } });
    await expect(
      controller.report(principal(t.id, 'OWNER'), {
        from: '2026-03-05',
        to: '2026-03-01',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_RANGE' } });
  });
});
