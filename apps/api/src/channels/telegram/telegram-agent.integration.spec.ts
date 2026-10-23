import type { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentConversationService } from '../../agent/agent-conversation.service.js';
import type { AgentModePolicy } from '../../agent/agent-mode.js';
import { LlmBudgetLedger } from '../../agent/llm-budget-ledger.js';
import { LlmUsageStore } from '../../agent/llm-usage.store.js';
import { extraction } from '../../agent/testing/agent-harness.js';
import type { AppEnvironment } from '../../config/environment.js';
import {
  parsePostgresEnvironment,
  postgresPoolOptions,
} from '../../config/postgres-config.js';
import { createConnectorRegistry } from '../../connectors/connectors.module.js';
import { TenantConnectorLoader } from '../../connectors/sync/tenant-connector-loader.js';
import {
  LlmError,
  type LlmProvider,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type ToolGenerationRequest,
  type ToolGenerationResult,
} from '../../core/llm/llm-provider.js';
import {
  ScriptedLlmProvider,
  type ScriptRequest,
  type ScriptStep,
} from '../../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { UZ_LATN } from '../../locales/locale-packs.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { TelegramAgentPipeline } from './telegram-agent-pipeline.js';
import { normalizeTelegramUpdate } from './telegram-normalizer.js';
import {
  TelegramProcessor,
  type TelegramQueueEvent,
} from './telegram-processor.js';
import type { TelegramSender } from './telegram-sender.js';
import { TelegramQueueRuntime } from './telegram-queue.runtime.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Agent pipeline integration tests require agentcore_test');
}

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
/**
 * The pipeline under test runs on a one-connection pool with its own
 * application_name: if any step held a connection or transaction during the
 * model call, a concurrent query on this pool would block, and
 * pg_stat_activity would show the session idle in transaction.
 */
const APP_NAME = `agentcore-it-${process.pid}`;
const limited = new PrismaClient({
  adapter: new PrismaPg({
    ...postgresPoolOptions(parsePostgresEnvironment(process.env, 'TEST_')),
    max: 1,
    application_name: APP_NAME,
  }),
});

const DEV: AgentModePolicy = {
  nodeEnv: 'development',
  operatorNotifierConfigured: false,
  providerTrusted: true,
  allowRealCustomerData: false,
};
const PROD: AgentModePolicy = { ...DEV, nodeEnv: 'production' };
const UNTRUSTED: AgentModePolicy = { ...DEV, providerTrusted: false };

const settings: Partial<AppEnvironment> = {
  NODE_ENV: 'test',
  LLM_PROVIDER: 'mock',
  LLM_PRICING_VERSION: 'anthropic-2026-10-23',
  LLM_MAX_OUTPUT_TOKENS: 1_024,
  LLM_MAX_INPUT_BYTES: 48_000,
  LLM_MAX_CALLS_PER_TURN: 6,
  LLM_MAX_TOOL_ROUNDS: 3,
  LLM_MAX_TOOL_CALLS_PER_TURN: 6,
  LLM_TURN_BUDGET_USD: '0.02',
  LLM_CONVERSATION_BUDGET_USD: '0.25',
  AGENT_TOOL_TIMEOUT_MS: 2_000,
  AGENT_HISTORY_MESSAGES: 8,
  AGENT_TURN_TIMEOUT_MS: 10_000,
  AGENT_TURN_LEASE_MS: 30_000,
};

function config(
  values: Record<string, unknown>,
): ConfigService<AppEnvironment, true> {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<AppEnvironment, true>;
}

/** Scripted provider whose calls can be held open by the test. */
class GatedProvider implements LlmProvider {
  readonly providerId = 'mock';
  readonly inner: ScriptedLlmProvider;
  private gate: Promise<void> | undefined;
  private release: (() => void) | undefined;
  private entered: (() => void) | undefined;
  readonly customerTexts: string[] = [];

  constructor(responder: (call: ScriptRequest) => ScriptStep) {
    this.inner = new ScriptedLlmProvider(responder);
  }

  modelFor(): string {
    return this.inner.modelFor('FAST');
  }

  /** Holds the next structured call; resolves once a call is waiting. */
  hold(): Promise<void> {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    return new Promise((resolve) => {
      this.entered = resolve;
    });
  }

  open(): void {
    this.release?.();
    this.gate = undefined;
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const user = request.messages[0];
    if (user?.role === 'user') {
      const match =
        /<latest_customer_message>([\s\S]*?)<\/latest_customer_message>/u.exec(
          user.text,
        );
      this.customerTexts.push(match?.[1] ?? '');
    }
    if (this.gate) {
      const gate = this.gate;
      this.entered?.();
      await gate;
    }
    return this.inner.generateStructured(request);
  }

  generateWithTools(
    request: ToolGenerationRequest,
  ): Promise<ToolGenerationResult> {
    return this.inner.generateWithTools(request);
  }
}

interface Fixture {
  tenantId: string;
  channelAccountId: string;
  webhook: TelegramWebhookService;
  processor: TelegramProcessor;
  pipeline: TelegramAgentPipeline;
  sender: { sendMessage: ReturnType<typeof vi.fn> };
  provider: GatedProvider;
}

async function fixture(options: {
  mode: 'OFF' | 'SHADOW' | 'LIVE';
  isTestAccount?: boolean;
  responder?: (call: ScriptRequest) => ScriptStep;
  policy?: AgentModePolicy;
  connectorConfig?: Record<string, string>;
  overrides?: Partial<AppEnvironment>;
}): Promise<Fixture> {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: {
      slug: `agent-pipeline-${suffix}`,
      name: 'Agent pipeline fixture',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  await prisma.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: 'mock',
      status: 'ACTIVE',
      config: options.connectorConfig ?? { sourceSystem: 'mock-education' },
    },
  });
  const account = await prisma.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `agent-pipeline-${suffix}`,
      status: 'ACTIVE',
      agentMode: options.mode,
      isTestAccount: options.isTestAccount ?? false,
    },
  });
  const values = { ...settings, ...options.overrides };
  const cfg = config(values);
  const database = limited as unknown as PrismaService;
  const provider = new GatedProvider(
    options.responder ??
      ((call): ScriptStep =>
        call.type === 'structured'
          ? extraction({ subject: 'IELTS' })
          : { kind: 'tools', text: 'Sizga {{F1}} kursi mos keladi.' }),
  );
  const agent = new AgentConversationService(
    database,
    new TenantConnectorLoader(
      database,
      createConnectorRegistry({
        NODE_ENV: 'test',
        CONNECTOR_OUTBOUND_POLICY: 'strict',
      }),
    ),
    new LlmUsageStore(database),
    new LlmBudgetLedger(database),
    provider,
    cfg,
  );
  const pipeline = new TelegramAgentPipeline(
    database,
    agent,
    cfg,
    options.policy ?? DEV,
  );
  const sender = { sendMessage: vi.fn() };
  return {
    tenantId: tenant.id,
    channelAccountId: account.id,
    webhook: new TelegramWebhookService(
      prisma as unknown as PrismaService,
      config({
        TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
        TELEGRAM_WEBHOOK_SECRET: 'integration-secret',
        TELEGRAM_RATE_LIMIT_PER_MINUTE: 1_000,
      }),
    ),
    processor: new TelegramProcessor(
      database,
      sender as unknown as TelegramSender,
      pipeline,
    ),
    pipeline,
    sender,
    provider,
  };
}

let nextUpdate = 70_000;
async function receive(
  f: Fixture,
  text: string,
  chatId = 4_242,
): Promise<TelegramQueueEvent> {
  const updateId = ++nextUpdate;
  const normalized = normalizeTelegramUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: chatId },
      from: { id: 77 },
      text,
    },
  });
  if (normalized.kind !== 'text') throw new Error('expected text');
  expect(await f.webhook.accept(f.channelAccountId, normalized)).toBe(
    'accepted',
  );
  const outbox = await prisma.outboxEvent.findFirstOrThrow({
    where: {
      tenantId: f.tenantId,
      type: 'telegram.inbound',
      idempotencyKey: `telegram.inbound:${f.channelAccountId}:${updateId}`,
    },
  });
  return {
    outboxId: outbox.id,
    tenantId: f.tenantId,
    type: outbox.type,
    payload: outbox.payload,
  };
}

async function turns(
  f: Fixture,
): Promise<Awaited<ReturnType<typeof prisma.agentTurn.findMany>>> {
  return prisma.agentTurn.findMany({
    where: { tenantId: f.tenantId },
    orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }],
  });
}

async function outbound(f: Fixture): Promise<number> {
  return prisma.message.count({
    where: { tenantId: f.tenantId, direction: 'OUTBOUND' },
  });
}

beforeAll(async () => {
  await Promise.all([prisma.$connect(), limited.$connect()]);
});
afterAll(async () => {
  await Promise.all([prisma.$disconnect(), limited.$disconnect()]);
});

describe('agent mode OFF', () => {
  it('keeps the Phase 2 echo unchanged', async () => {
    const f = await fixture({ mode: 'OFF' });
    await f.processor.process(await receive(f, 'salom'));
    const replies = await prisma.message.findMany({
      where: { tenantId: f.tenantId, direction: 'OUTBOUND' },
    });
    expect(replies.map((reply) => reply.text)).toEqual(['salom']);
    expect(await turns(f)).toHaveLength(0);
    expect(f.provider.inner.calls).toHaveLength(0);
  });
});

describe('agent mode SHADOW', () => {
  it('stores the draft and the turn record but never sends', async () => {
    const f = await fixture({ mode: 'SHADOW' });
    const event = await receive(f, 'IELTS kursi kerak, tel +998901234567');
    await f.processor.process(event);
    const [turn] = await turns(f);
    expect(turn).toMatchObject({
      status: 'COMMITTED',
      mode: 'SHADOW',
      outcome: 'ANSWERED',
      attempt: 1,
      provider: 'mock',
      models: ['mock-deterministic'],
      llmCalls: 2,
      replyMessageId: null,
      handoverId: null,
      pricingVersion: 'anthropic-2026-10-23',
      packRef: 'education@1',
    });
    expect(turn.draftText).toContain('IELTS Preparation');
    expect(turn.inputTokens).toBeGreaterThan(0);
    expect(turn.actualCostNano).toBeGreaterThan(0n);
    expect(turn.estimatedCostNano).toBeGreaterThanOrEqual(turn.actualCostNano);
    expect(turn.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    const tools = turn.toolCalls as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({
      name: 'search_catalog',
      origin: 'code',
      outcome: 'FOUND',
    });
    expect(
      JSON.stringify(turn, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('998901234567');
    expect(await outbound(f)).toBe(0);
    expect(
      await prisma.outboxEvent.count({
        where: { tenantId: f.tenantId, type: 'telegram.send' },
      }),
    ).toBe(0);
    expect(f.sender.sendMessage).not.toHaveBeenCalled();
    expect(
      await prisma.inboundEvent.findMany({
        where: { tenantId: f.tenantId },
        select: { status: true },
      }),
    ).toEqual([{ status: 'PROCESSED' }]);
    // Usage is recorded once per billed call, keyed by this attempt.
    expect(
      await prisma.llmUsageRecord.count({
        where: { tenantId: f.tenantId, turnKey: turn.id },
      }),
    ).toBe(2);
  });

  it('records a handover outcome without a Handover row or state change', async () => {
    const f = await fixture({
      mode: 'SHADOW',
      responder: () => extraction({}, 'human_request'),
    });
    await f.processor.process(await receive(f, 'operator kerak'));
    const [turn] = await turns(f);
    expect(turn).toMatchObject({
      outcome: 'HANDOVER',
      handoverReason: 'CUSTOMER_REQUEST',
      status: 'COMMITTED',
    });
    expect(
      await prisma.handover.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    expect(conversation.state).toBe('BOT_ACTIVE');
  });

  it('degrades a refused LIVE account to SHADOW', async () => {
    const f = await fixture({ mode: 'LIVE', policy: PROD });
    await f.processor.process(await receive(f, 'IELTS'));
    const [turn] = await turns(f);
    expect(turn).toMatchObject({ mode: 'SHADOW', status: 'COMMITTED' });
    expect(await outbound(f)).toBe(0);
  });
});

describe('data-protection guard (untrusted provider)', () => {
  it('holds a real account: no model call, no reply, batch closed', async () => {
    const f = await fixture({ mode: 'SHADOW', policy: UNTRUSTED });
    await f.processor.process(await receive(f, 'IELTS +998901234567'));
    expect(f.provider.inner.calls).toHaveLength(0);
    expect(await turns(f)).toHaveLength(0);
    expect(await outbound(f)).toBe(0);
    expect(
      await prisma.inboundEvent.findMany({
        where: { tenantId: f.tenantId },
        select: { status: true },
      }),
    ).toEqual([{ status: 'PROCESSED' }]);
  });

  it('runs SHADOW on a test account and refuses LIVE there', async () => {
    const f = await fixture({
      mode: 'LIVE',
      isTestAccount: true,
      policy: UNTRUSTED,
    });
    await f.processor.process(await receive(f, 'IELTS'));
    const [turn] = await turns(f);
    expect(turn).toMatchObject({ mode: 'SHADOW', status: 'COMMITTED' });
    expect(await outbound(f)).toBe(0);
  });

  it('runs SHADOW on a real account with the explicit override', async () => {
    const f = await fixture({
      mode: 'SHADOW',
      policy: { ...UNTRUSTED, allowRealCustomerData: true },
    });
    await f.processor.process(await receive(f, 'IELTS'));
    expect((await turns(f))[0]).toMatchObject({ mode: 'SHADOW' });
  });
});

describe('agent mode LIVE (local development policy)', () => {
  it('commits the reply and its outbox event atomically, idempotently', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const event = await receive(f, 'IELTS kerak');
    await f.processor.process(event);
    // Duplicate job delivery: nothing left to answer.
    await f.processor.process(event);
    const replies = await prisma.message.findMany({
      where: { tenantId: f.tenantId, direction: 'OUTBOUND' },
    });
    expect(replies).toHaveLength(1);
    const [turn] = await turns(f);
    expect(replies[0]).toMatchObject({
      authorType: 'BOT',
      deliveryState: 'PENDING',
      sendIdempotencyKey: turn.idempotencyKey,
      id: turn.replyMessageId,
    });
    expect(turn.idempotencyKey).toMatch(/^agent-reply:[0-9a-f-]+:\d+$/u);
    expect(
      await prisma.outboxEvent.count({
        where: { tenantId: f.tenantId, type: 'telegram.send' },
      }),
    ).toBe(1);
    expect(await turns(f)).toHaveLength(1);
    expect(f.provider.inner.calls).toHaveLength(2);
  });

  it.each([
    [
      'LLM_UNAVAILABLE',
      (): ScriptStep => ({
        kind: 'error',
        error: new LlmError('LLM_UNAVAILABLE', 'down', true),
      }),
      undefined,
    ],
    [
      'GUARDRAIL',
      (call: ScriptRequest): ScriptStep =>
        call.type === 'structured'
          ? extraction({ subject: 'IELTS' })
          : { kind: 'tools', text: 'Narxi 99 dollar' },
      undefined,
    ],
    [
      'TOOL_LOOP_LIMIT',
      (call: ScriptRequest): ScriptStep =>
        call.type === 'structured'
          ? extraction({ subject: 'IELTS' })
          : {
              kind: 'tools',
              toolCalls: [
                {
                  name: 'list_offers',
                  input: { itemId: 'mock-education:edu-ielts-001' },
                },
              ],
            },
      undefined,
    ],
    [
      'CONNECTOR_UNAVAILABLE',
      (): ScriptStep => extraction({ subject: 'IELTS' }),
      { sourceSystem: 'mock-education', failureMode: 'transient' },
    ],
  ] as const)(
    'persists a durable %s handover with a safe acknowledgment',
    async (reason, responder, connectorConfig) => {
      const f = await fixture({
        mode: 'LIVE',
        responder,
        ...(connectorConfig ? { connectorConfig } : {}),
      });
      await f.processor.process(await receive(f, 'IELTS kursi narxi?'));
      const handover = await prisma.handover.findFirstOrThrow({
        where: { tenantId: f.tenantId },
      });
      const [turn] = await turns(f);
      expect(handover).toMatchObject({
        reasonCode: reason,
        status: 'OPEN',
        notificationStatus: 'PENDING',
        idempotencyKey: `handover:${turn.idempotencyKey}`,
        id: turn.handoverId,
      });
      expect(handover.summary).toMatchObject({
        unknowns: expect.arrayContaining([`reason=${reason}`]),
      });
      const reply = await prisma.message.findFirstOrThrow({
        where: { tenantId: f.tenantId, direction: 'OUTBOUND' },
      });
      expect(reply.text).toBe(UZ_LATN.templates.handover[reason]);
      const conversation = await prisma.conversation.findFirstOrThrow({
        where: { tenantId: f.tenantId },
      });
      expect(conversation).toMatchObject({
        state: 'WAITING_OPERATOR',
        version: 2,
      });

      // The bot stays silent while the conversation waits for an operator.
      await f.processor.process(await receive(f, 'hello?'));
      expect(await outbound(f)).toBe(1);
      expect(await turns(f)).toHaveLength(1);
    },
  );

  it('hands over BUDGET_EXCEEDED from the stored ledger without a model call', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const event = await receive(f, 'IELTS');
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    await prisma.llmUsageRecord.create({
      data: {
        tenantId: f.tenantId,
        conversationId: conversation.id,
        turnKey: 'earlier',
        callIndex: 0,
        purpose: 'respond',
        tier: 'STRONG',
        provider: 'mock',
        model: 'mock-deterministic',
        responseId: `r-${randomUUID()}`,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        costNano: 250_000_000n,
        reservedNano: 250_000_000n,
        pricingVersion: 'anthropic-2026-10-23',
        durationMs: 1,
        attempts: 1,
        outcome: 'end',
      },
    });
    await f.processor.process(event);
    expect(f.provider.inner.calls).toHaveLength(0);
    await expect(
      prisma.handover.findFirstOrThrow({ where: { tenantId: f.tenantId } }),
    ).resolves.toMatchObject({ reasonCode: 'BUDGET_EXCEEDED' });
  });
});

describe('claim -> compute -> commit concurrency', () => {
  it('holds no transaction, lock or pooled connection while the model runs', async () => {
    const f = await fixture({ mode: 'SHADOW' });
    const event = await receive(f, 'IELTS');
    const waiting = f.provider.hold();
    const run = f.processor.process(event);
    await waiting;
    // One-connection pool: this would block if compute held the connection.
    const probe = await Promise.race([
      limited.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`,
      new Promise<'blocked'>((resolve) =>
        setTimeout(() => resolve('blocked'), 3_000),
      ),
    ]);
    expect(probe).toEqual([{ ok: 1 }]);
    const sessions = await prisma.$queryRaw<
      Array<{ in_transaction: number; advisory: number }>
    >`
      SELECT
        count(*) FILTER (WHERE a.state LIKE 'idle in transaction%')::int AS in_transaction,
        (SELECT count(*)::int FROM pg_locks l
           JOIN pg_stat_activity s ON s.pid = l.pid
          WHERE l.locktype = 'advisory' AND s.application_name = ${APP_NAME}) AS advisory
      FROM pg_stat_activity a
      WHERE a.application_name = ${APP_NAME}`;
    expect(sessions).toEqual([{ in_transaction: 0, advisory: 0 }]);
    const [computing] = await turns(f);
    expect(computing.status).toBe('COMPUTING');
    f.provider.open();
    await run;
    expect((await turns(f))[0].status).toBe('COMMITTED');
  });

  it('discards a reply superseded by a newer message and answers the merged batch', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const first = await receive(f, 'IELTS');
    const waiting = f.provider.hold();
    const run = f.processor.process(first);
    await waiting;
    const second = await receive(f, 'onlayn');
    f.provider.open();
    await run;
    const all = await turns(f);
    expect(all.map((turn) => [turn.status, turn.discardReason])).toEqual([
      ['DISCARDED', 'SUPERSEDED'],
      ['COMMITTED', null],
    ]);
    // The re-run answered both messages together.
    expect(f.provider.customerTexts).toEqual(['IELTS', 'IELTS\nonlayn']);
    expect(all[1].answeredSequence).toBeGreaterThan(all[0].answeredSequence);
    expect(await outbound(f)).toBe(1);
    // The newer message's own job finds nothing left.
    await f.processor.process(second);
    expect(await outbound(f)).toBe(1);
    expect(await turns(f)).toHaveLength(2);
  });

  it('discards the reply when an operator takes over during compute', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const event = await receive(f, 'IELTS');
    const waiting = f.provider.hold();
    const run = f.processor.process(event);
    await waiting;
    await prisma.conversation.updateMany({
      where: { tenantId: f.tenantId },
      data: { state: 'OPERATOR_ACTIVE', version: { increment: 1 } },
    });
    f.provider.open();
    await run;
    const [turn] = await turns(f);
    expect(turn).toMatchObject({
      status: 'DISCARDED',
      discardReason: 'STATE_CHANGED',
    });
    expect(turn.llmCalls).toBe(2);
    expect(await outbound(f)).toBe(0);
    expect(
      await prisma.inboundEvent.findMany({
        where: { tenantId: f.tenantId },
        select: { status: true },
      }),
    ).toEqual([{ status: 'PROCESSED' }]);
  });

  it('lets a second worker wait instead of computing in parallel', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const first = await receive(f, 'IELTS');
    const waiting = f.provider.hold();
    const run = f.processor.process(first);
    await waiting;
    const second = await receive(f, 'oflayn');
    const busy = await f.processor.process(second);
    expect(busy).toMatchObject({ retryAt: expect.any(Date) });
    f.provider.open();
    await run;
    await f.processor.process(second);
    const committed = (await turns(f)).filter(
      (turn) => turn.status === 'COMMITTED',
    );
    expect(committed).toHaveLength(1);
    expect(await outbound(f)).toBe(1);
  });

  it('recovers a worker crash between compute and commit with a new attempt', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const event = await receive(f, 'IELTS');
    const commit = vi
      .spyOn(f.pipeline, 'commit')
      .mockRejectedValueOnce(new Error('worker crashed'));
    await expect(f.processor.process(event)).rejects.toThrow('worker crashed');
    expect((await turns(f))[0].status).toBe('COMPUTING');
    // Queue retry of the same job (same outbox id).
    await f.processor.process(event);
    commit.mockRestore();
    const all = await turns(f);
    expect(all.map((turn) => [turn.attempt, turn.status])).toEqual([
      [1, 'ABANDONED'],
      [2, 'COMMITTED'],
    ]);
    expect(all[0].discardReason).toBe('RETRIED');
    // Each attempt's calls are recorded once, under that attempt.
    for (const turn of all) {
      expect(
        await prisma.llmUsageRecord.count({
          where: { tenantId: f.tenantId, turnKey: turn.id },
        }),
      ).toBe(2);
    }
    expect(await outbound(f)).toBe(1);
  });

  it('takes over a turn whose lease expired', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const event = await receive(f, 'IELTS');
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    const inbound = await prisma.inboundEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    await prisma.inboundEvent.update({
      where: { id: inbound.id },
      data: { status: 'PROCESSING' },
    });
    await prisma.agentTurn.create({
      data: {
        tenantId: f.tenantId,
        conversationId: conversation.id,
        channelAccountId: f.channelAccountId,
        idempotencyKey: `agent-reply:${conversation.id}:1`,
        attempt: 1,
        mode: 'LIVE',
        claimToken: 'dead-worker-job',
        leaseExpiresAt: new Date(Date.now() - 1_000),
        answeredSequence: 1,
        seenInboundSequence: 1,
        conversationVersion: 1,
        inboundEventIds: [inbound.id],
        correlationId: randomUUID(),
      },
    });
    await f.processor.process(event);
    const all = await turns(f);
    expect(all.map((turn) => [turn.status, turn.discardReason])).toEqual([
      ['ABANDONED', 'LEASE_EXPIRED'],
      ['COMMITTED', null],
    ]);
    expect(await outbound(f)).toBe(1);
  });

  it('answers a debounced burst in one turn', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const first = await receive(f, 'IELTS');
    const second = await receive(f, 'kechqurun');
    await Promise.all([
      f.processor.process(first),
      f.processor.process(second),
    ]);
    const committed = (await turns(f)).filter(
      (turn) => turn.status === 'COMMITTED',
    );
    expect(committed).toHaveLength(1);
    expect(committed[0].inboundEventIds).toHaveLength(2);
    expect(f.provider.customerTexts).toContain('IELTS\nkechqurun');
    expect(await outbound(f)).toBe(1);
  });

  it('hands over LLM_UNAVAILABLE when the whole-turn deadline fires', async () => {
    const f = await fixture({
      mode: 'LIVE',
      overrides: { AGENT_TURN_TIMEOUT_MS: 200 },
    });
    const event = await receive(f, 'IELTS');
    void f.provider.hold();
    try {
      await f.processor.process(event);
    } finally {
      f.provider.open();
    }
    const [turn] = await turns(f);
    expect(turn).toMatchObject({
      status: 'COMMITTED',
      outcome: 'HANDOVER',
      handoverReason: 'LLM_UNAVAILABLE',
      failureCode: 'TURN_TIMEOUT',
    });
    expect(turn.guardrail).toMatchObject({ timedOut: true });
    await expect(
      prisma.handover.findFirstOrThrow({ where: { tenantId: f.tenantId } }),
    ).resolves.toMatchObject({ reasonCode: 'LLM_UNAVAILABLE' });
  });

  it('enforces one in-flight turn per conversation in the database', async () => {
    const f = await fixture({ mode: 'SHADOW' });
    await receive(f, 'IELTS');
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    const row = (
      n: number,
    ): Parameters<typeof prisma.agentTurn.create>[0]['data'] => ({
      tenantId: f.tenantId,
      conversationId: conversation.id,
      channelAccountId: f.channelAccountId,
      idempotencyKey: `agent-reply:${conversation.id}:${n}`,
      attempt: 1,
      mode: 'SHADOW',
      claimToken: `job-${n}`,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      answeredSequence: n,
      seenInboundSequence: n,
      conversationVersion: 1,
      inboundEventIds: [],
      correlationId: randomUUID(),
    });
    await prisma.agentTurn.create({ data: row(1) });
    await expect(prisma.agentTurn.create({ data: row(2) })).rejects.toThrow();
  });
});

describe('BullMQ end to end (shadow mode, mock model)', () => {
  it('turns a Telegram update into a stored draft and sends nothing', async () => {
    const f = await fixture({ mode: 'SHADOW' });
    // The runtime drains every pending row in the shared test database, so
    // this test uses its own chat and asserts on that chat only.
    const chatId = 900_000 + Math.floor(Math.random() * 99_000);
    f.sender.sendMessage.mockResolvedValue({ messageId: '1' });
    await receive(f, 'IELTS kursi kerak', chatId);
    const runtime = new TelegramQueueRuntime(
      config({ REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379' }),
      limited as unknown as PrismaService,
      f.processor,
    );
    runtime.onModuleInit();
    try {
      const deadline = Date.now() + 20_000;
      let turn = null;
      while (Date.now() < deadline) {
        turn = await prisma.agentTurn.findFirst({
          where: { tenantId: f.tenantId, status: 'COMMITTED' },
        });
        if (turn) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      expect(turn).toMatchObject({ mode: 'SHADOW', outcome: 'ANSWERED' });
      expect(turn?.draftText).toContain('IELTS Preparation');
      expect(await outbound(f)).toBe(0);
      expect(
        f.sender.sendMessage.mock.calls.filter(
          ([target]) => target === String(chatId),
        ),
      ).toHaveLength(0);
    } finally {
      await runtime.onModuleDestroy();
    }
  });
});
