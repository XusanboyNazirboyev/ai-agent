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
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { HashingEmbeddingProvider } from '../llm/embeddings/hashing-embedding-provider.js';
import { LlmBudgetLedger } from './llm-budget-ledger.js';
import { LlmUsageStore } from './llm-usage.store.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Agent integration tests require agentcore_test');
}

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const database = prisma as unknown as PrismaService;
const embedder = new HashingEmbeddingProvider(64);

const settings: Partial<AppEnvironment> = {
  LLM_PROVIDER: 'mock',
  LLM_TRUSTED_PROVIDERS: [],
  LLM_ALLOW_REAL_CUSTOMER_DATA: false,
  LLM_FAST_MODEL: 'claude-haiku-5-5',
  LLM_STRONG_MODEL: 'claude-haiku-5-5',
  LLM_EFFORT: 'low',
  LLM_PRICING_VERSION: 'local-free-2026-10-23',
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
  withKnowledge = true,
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
    withKnowledge ? new KnowledgeService(database) : undefined,
    withKnowledge ? embedder : undefined,
  );
}

async function fixture(isTestAccount = true): Promise<{
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
      isTestAccount,
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

const POLICY =
  'Refund policy. Lessons can be cancelled in the first week and the unused part is refunded.';

async function seed(tenantId: string, regulated = false): Promise<void> {
  const knowledge = new KnowledgeService(database);
  await knowledge.ingest(
    {
      tenantId,
      title: 'Refunds',
      source: 'Refund policy',
      sourceUpdatedAt: new Date(),
      text: POLICY,
      topic: 'refunds',
      regulated,
    },
    async (texts) => ({
      vectors: (await embedder.embed(texts)).vectors,
      model: embedder.model,
    }),
  );
}

describe('knowledge in a real turn', () => {
  it('retrieves a tenant passage through metered embeddings and shows it verbatim', async () => {
    const ids = await fixture();
    await seed(ids.tenantId);
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'details', 'en', 'Latn'),
      {
        kind: 'tools',
        toolCalls: [
          {
            name: 'knowledge_search',
            input: { query: 'Refund policy lessons cancelled' },
          },
        ],
      },
      { kind: 'tools', text: '{{F1}} {{F2}}' },
    ]);
    const result = await service(provider).handleCustomerMessage({
      ...ids,
      turnKey: 'k-1',
      text: 'IELTS refund policy?',
    });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.reply).toContain(
      'Lessons can be cancelled in the first week',
    );
    expect(
      result.facts.find((f) => f.value.kind === 'knowledge'),
    ).toMatchObject({
      value: { source: 'Refund policy' },
      provenance: {
        tenantId: ids.tenantId,
        conversationId: ids.conversationId,
      },
    });
    const usage = await prisma.llmUsageRecord.findMany({
      where: { tenantId: ids.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    expect(usage.map((row) => row.purpose)).toContain('embed');
    const embed = usage.find((row) => row.purpose === 'embed')!;
    expect(embed).toMatchObject({
      provider: 'hashing-test',
      model: 'hashing-test-embedder',
      turnKey: 'k-1',
    });
  });

  it('never retrieves another tenant’s knowledge', async () => {
    const mine = await fixture();
    const theirs = await fixture();
    await seed(theirs.tenantId);
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'details', 'en', 'Latn'),
      {
        kind: 'tools',
        toolCalls: [
          {
            name: 'knowledge_search',
            input: { query: 'Refund policy lessons cancelled' },
          },
        ],
      },
      { kind: 'tools', text: '{{F1}} Siyosatni operator tasdiqlaydi.' },
    ]);
    const result = await service(provider).handleCustomerMessage({
      ...mine,
      turnKey: 'k-2',
      text: 'IELTS refund policy?',
    });
    expect(result.facts.some((f) => f.value.kind === 'knowledge')).toBe(false);
    expect(result.reply).not.toContain('cancelled');
  });

  it('is not used for a real-customer account without consent or a trusted provider', async () => {
    const ids = await fixture(false);
    await seed(ids.tenantId);
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'details', 'en', 'Latn'),
      { kind: 'tools', text: '{{F1}}' },
    ]);
    await service(provider).handleCustomerMessage({
      ...ids,
      turnKey: 'k-3',
      text: 'IELTS refund policy?',
    });
    const offered = provider.calls.flatMap((c) =>
      c.type === 'tools' ? c.request.tools.map((t) => t.name) : [],
    );
    expect(offered).not.toContain('knowledge_search');
    expect(
      await prisma.llmUsageRecord.count({
        where: { tenantId: ids.tenantId, purpose: 'embed' },
      }),
    ).toBe(0);
    // With the owner's explicit consent it is offered.
    const consenting = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'details', 'en', 'Latn'),
      { kind: 'tools', text: '{{F1}}' },
    ]);
    await service(consenting, {
      LLM_ALLOW_REAL_CUSTOMER_DATA: true,
    }).handleCustomerMessage({
      ...ids,
      turnKey: 'k-4',
      text: 'IELTS refund policy?',
    });
    expect(
      consenting.calls.flatMap((c) =>
        c.type === 'tools' ? c.request.tools.map((t) => t.name) : [],
      ),
    ).toContain('knowledge_search');
  });

  it('hands over a regulated question as LEGAL_UNVERIFIED unless a fresh regulated source exists', async () => {
    const without = await fixture();
    await seed(without.tenantId, false);
    const steps = (): ScriptedLlmProvider =>
      new ScriptedLlmProvider([
        extraction({}, 'regulated_info', 'en', 'Latn'),
        { kind: 'tools', text: 'See {{F1}}' },
      ]);
    const a = await service(steps()).handleCustomerMessage({
      ...without,
      turnKey: 'k-5',
      text: 'What does the law say about refund policy for lessons?',
    });
    expect(a).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'LEGAL_UNVERIFIED',
    });
    const withSource = await fixture();
    await seed(withSource.tenantId, true);
    const b = await service(steps()).handleCustomerMessage({
      ...withSource,
      turnKey: 'k-6',
      text: 'What does the law say about refund policy for lessons?',
    });
    expect(b.outcome).toBe('ANSWERED');
    expect(b.reply).toContain('Refund policy');
    expect(b.reply).toMatch(/\d{4}/u); // the verification date is shown
  });

  it('runs without knowledge when no embedder is configured', async () => {
    const ids = await fixture();
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'details', 'en', 'Latn'),
      { kind: 'tools', text: '{{F1}}' },
    ]);
    const result = await service(provider, {}, false).handleCustomerMessage({
      ...ids,
      turnKey: 'k-7',
      text: 'IELTS',
    });
    expect(result.outcome).toBe('ANSWERED');
  });
});
