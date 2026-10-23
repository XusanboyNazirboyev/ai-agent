import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { createConnectorRegistry } from '../connectors/connectors.module.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { extraction } from './testing/agent-harness.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AgentConversationService } from './agent-conversation.service.js';
import { LlmUsageStore } from './llm-usage.store.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Agent integration tests require agentcore_test');
}

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const database = prisma as unknown as PrismaService;

const settings: Partial<AppEnvironment> = {
  LLM_PROVIDER: 'mock',
  LLM_FAST_MODEL: 'claude-haiku-5-5',
  LLM_STRONG_MODEL: 'claude-haiku-5-5',
  LLM_EFFORT: 'low',
  LLM_PRICING_VERSION: 'anthropic-2026-10-23',
  LLM_REQUEST_TIMEOUT_MS: 20_000,
  LLM_MAX_RETRIES: 2,
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

function service(
  provider: ScriptedLlmProvider,
  overrides: Partial<AppEnvironment> = {},
): AgentConversationService {
  const values = { ...settings, ...overrides };
  const config = {
    get: (key: keyof AppEnvironment) => values[key],
  } as unknown as ConfigService<AppEnvironment, true>;
  const registry = createConnectorRegistry({
    NODE_ENV: 'test',
    CONNECTOR_OUTBOUND_POLICY: 'strict',
  });
  return new AgentConversationService(
    database,
    new TenantConnectorLoader(database, registry),
    new LlmUsageStore(database),
    provider,
    config,
  );
}

async function fixture(): Promise<{
  tenantId: string;
  conversationId: string;
}> {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: {
      slug: `agent-${suffix}`,
      name: 'Agent integration fixture',
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
      config: { sourceSystem: 'mock-education' },
    },
  });
  const account = await prisma.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `agent-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await prisma.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `user-${suffix}`,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `chat-${suffix}`,
    },
  });
  return { tenantId: tenant.id, conversationId: conversation.id };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('AgentConversationService', () => {
  it('runs a two-turn dialog, persisting slots, locale and usage', async () => {
    const ids = await fixture();
    const steps: ScriptStep[] = [
      extraction({}, 'greeting', 'uz', 'Cyrl'),
      extraction({ subject: 'IELTS' }, 'search', 'uz', 'Cyrl'),
      {
        kind: 'tools',
        text: 'Сизга {{F1}} курси мос келади. Онлайн ёки марказда ўқийсизми?',
      },
    ];
    const agent = service(new ScriptedLlmProvider(steps));

    const first = await agent.handleCustomerMessage({
      ...ids,
      turnKey: 'msg-1',
      text: 'Ассалому алайкум, курс керак эди',
    });
    expect(first).toMatchObject({
      outcome: 'ASKED_SLOT',
      askedSlot: 'subject',
      locale: 'uz-Cyrl',
    });

    const second = await agent.handleCustomerMessage({
      ...ids,
      turnKey: 'msg-2',
      text: 'IELTS',
    });
    expect(second.locale).toBe('uz-Cyrl');
    expect(second.outcome).toBe('ANSWERED');
    expect(second.reply).toContain('IELTS Preparation');

    const slots = await prisma.conversationSlots.findMany({
      where: { tenantId: ids.tenantId, conversationId: ids.conversationId },
      orderBy: { version: 'asc' },
    });
    expect(slots.map((row) => row.version)).toEqual([1]);
    expect(slots[0].slots).toMatchObject({
      slots: { subject: { value: 'IELTS', source: 'customer' } },
    });
    await expect(
      prisma.conversation.findFirstOrThrow({
        where: { id: ids.conversationId },
      }),
    ).resolves.toMatchObject({ language: 'uz', script: 'Cyrl' });

    const usage = await prisma.llmUsageRecord.findMany({
      where: { tenantId: ids.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    expect(usage.map((row) => `${row.turnKey}:${row.purpose}`)).toEqual([
      'msg-1:extract',
      'msg-2:extract',
      'msg-2:respond',
    ]);
    expect(
      usage.every(
        (row) => row.conversationId === ids.conversationId && row.costNano > 0n,
      ),
    ).toBe(true);
  });

  it('records each provider response once', async () => {
    const ids = await fixture();
    const store = new LlmUsageStore(database);
    const entry = {
      tenantId: ids.tenantId,
      conversationId: ids.conversationId,
      turnKey: 't',
      callIndex: 0,
      purpose: 'extract' as const,
      tier: 'FAST' as const,
      providerId: 'anthropic',
      model: 'claude-haiku-5-5',
      responseId: 'msg_same',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      costNano: 3_500,
      reservedNano: 10_000,
      usageBasis: 'reported' as const,
      pricingVersion: 'anthropic-2026-10-23',
      durationMs: 1,
      attempts: 1,
      outcome: 'ok',
    };
    await store.record(entry);
    await store.record(entry);
    expect(
      await prisma.llmUsageRecord.count({ where: { tenantId: ids.tenantId } }),
    ).toBe(1);
    expect(
      await store.conversationSpendNano(ids.tenantId, ids.conversationId),
    ).toBe(3_500);
  });

  it('keeps unknown-usage exposure apart from spend and records it once', async () => {
    const ids = await fixture();
    const store = new LlmUsageStore(database);
    const base = {
      tenantId: ids.tenantId,
      conversationId: ids.conversationId,
      turnKey: 't',
      callIndex: 0,
      purpose: 'respond' as const,
      tier: 'STRONG' as const,
      providerId: 'routed',
      model: 'ma',
      responseId: 'unknown:t:0',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      costNano: 0,
      reservedNano: 7_000,
      usageBasis: 'unknown' as const,
      pricingVersion: 'routing-free-2026-10-23',
      durationMs: 0,
      attempts: 1,
      outcome: 'unknown_usage:LLM_TIMEOUT',
    };
    expect(await store.record(base)).toBe(true);
    expect(await store.record(base)).toBe(false);
    expect(
      await store.conversationExposureNano(ids.tenantId, ids.conversationId),
    ).toBe(7_000);
    expect(await store.tenantMonthExposureNano(ids.tenantId)).toBe(7_000);
    expect(
      await store.conversationSpendNano(ids.tenantId, ids.conversationId),
    ).toBe(0);
  });

  it('enforces the conversation budget from the stored ledger', async () => {
    const ids = await fixture();
    await prisma.llmUsageRecord.create({
      data: {
        tenantId: ids.tenantId,
        conversationId: ids.conversationId,
        turnKey: 'earlier',
        callIndex: 0,
        purpose: 'respond',
        tier: 'STRONG',
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        responseId: `msg_${randomUUID()}`,
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
        outcome: 'ok',
      },
    });
    const provider = new ScriptedLlmProvider([extraction({})]);
    const result = await service(provider).handleCustomerMessage({
      ...ids,
      turnKey: 'msg-x',
      text: 'IELTS kerak',
    });
    expect(result).toMatchObject({
      handover: 'BUDGET_EXCEEDED',
      budgetStop: 'CONVERSATION_COST_LIMIT',
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('rejects an invalid usage row in the database', async () => {
    const ids = await fixture();
    await expect(
      prisma.llmUsageRecord.create({
        data: {
          tenantId: ids.tenantId,
          turnKey: 'bad',
          callIndex: 0,
          purpose: 'extract',
          tier: 'FAST',
          provider: 'anthropic',
          model: 'm',
          responseId: 'r',
          inputTokens: -1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          costNano: 0n,
          reservedNano: 0n,
          pricingVersion: 'v',
          durationMs: 0,
          attempts: 0,
          outcome: 'ok',
        },
      }),
    ).rejects.toThrow();
  });
});
