/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { createConnectorRegistry } from '../connectors/connectors.module.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { extraction } from './testing/agent-harness.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AgentConversationService } from './agent-conversation.service.js';
import { LlmBudgetLedger } from './llm-budget-ledger.js';
import { LlmUsageStore } from './llm-usage.store.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Agent sandbox tests require agentcore_test');
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
    new LlmBudgetLedger(database),
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

async function tenantOnly(): Promise<string> {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: {
      slug: `sandbox-${suffix}`,
      name: 'Sandbox fixture',
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
  return tenant.id;
}

const countRows = async (tenantId: string) => ({
  conversations: await prisma.conversation.count({ where: { tenantId } }),
  contacts: await prisma.contact.count({ where: { tenantId } }),
  messages: await prisma.message.count({ where: { tenantId } }),
  slots: await prisma.conversationSlots.count({ where: { tenantId } }),
  turns: await prisma.agentTurn.count({ where: { tenantId } }),
  handovers: await prisma.handover.count({ where: { tenantId } }),
  leads: await prisma.lead.count({ where: { tenantId } }),
  channels: await prisma.channelAccount.count({ where: { tenantId } }),
});

describe('test chat sandbox (ADR 065)', () => {
  it('answers from the caller-held dialogue and writes no conversation data at all', async () => {
    const tenantId = await tenantOnly();
    const conversationId = randomUUID();
    const agent = service(
      new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }, 'search', 'uz', 'Cyrl'),
        {
          kind: 'tools',
          text: 'Сизга {{F1}} курси мос келади. Онлайн ёки марказда ўқийсизми?',
        },
      ]),
    );
    const computed = await agent.compute({
      tenantId,
      conversationId,
      turnKey: `sandbox-${randomUUID()}`,
      text: 'Ассалому алайкум, IELTS курс керак эди',
      readOnly: true,
      sandbox: { history: [], slots: {} },
    });
    expect(computed.result.outcome).toBe('ANSWERED');
    expect(computed.result.reply).toContain('IELTS Preparation');
    expect(computed.result.slots).toMatchObject({
      subject: { value: 'IELTS' },
    });
    // Nothing a customer conversation would leave behind exists.
    expect(await countRows(tenantId)).toEqual({
      conversations: 0,
      contacts: 0,
      messages: 0,
      slots: 0,
      turns: 0,
      handovers: 0,
      leads: 0,
      channels: 0,
    });
    // Only the cost is metered, under the sandbox key.
    const usage = await prisma.llmUsageRecord.findMany({ where: { tenantId } });
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((row) => row.conversationId === conversationId)).toBe(
      true,
    );
  });

  it('takes history, slots and language from the request, never from a stored conversation', async () => {
    const real = await fixture();
    // Give the real conversation a slot and a message the sandbox must not see.
    await prisma.conversationSlots.create({
      data: {
        tenantId: real.tenantId,
        conversationId: real.conversationId,
        version: 1,
        slots: {
          version: 1,
          slots: { subject: { value: 'IELTS', source: 'customer' } },
        },
      },
    });
    const agent = service(
      new ScriptedLlmProvider([
        extraction({}, 'greeting', 'en', 'Latn'),
        { kind: 'tools', text: 'Hello! How can I help?' },
      ]),
    );
    const before = await countRows(real.tenantId);
    const computed = await agent.compute({
      tenantId: real.tenantId,
      conversationId: real.conversationId,
      turnKey: `sandbox-${randomUUID()}`,
      text: 'Hello',
      readOnly: true,
      sandbox: { history: [], slots: {}, language: 'en', script: 'Latn' },
    });
    // The stored slot of that conversation was not used as the starting point.
    expect(computed.slotsBefore).toEqual({});
    expect(await countRows(real.tenantId)).toEqual(before);
  });

  it('refuses an unknown workspace like any other turn', async () => {
    const agent = service(new ScriptedLlmProvider([]));
    await expect(
      agent.compute({
        tenantId: randomUUID(),
        conversationId: randomUUID(),
        turnKey: 'x',
        text: 'Hello',
        sandbox: { history: [], slots: {} },
      }),
    ).rejects.toThrow('Unknown tenant');
  });
});
