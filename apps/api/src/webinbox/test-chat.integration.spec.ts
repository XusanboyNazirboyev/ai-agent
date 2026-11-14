/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import { createConnectorRegistry } from '../connectors/connectors.module.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { extraction } from '../agent/testing/agent-harness.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AgentConversationService } from '../agent/agent-conversation.service.js';
import { TestChatController } from './test-chat.controller.js';
import { LlmBudgetLedger } from '../agent/llm-budget-ledger.js';
import { LlmUsageStore } from '../agent/llm-usage.store.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Test chat tests require agentcore_test');
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

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

function as(tenantId: string, role: Role, operatorId = randomUUID()) {
  return {
    principal: { tenantId, operatorId, role, sessionId: randomUUID() },
  } as never;
}

const call = async (work: () => unknown) => {
  try {
    await work();
    return { status: 200, code: undefined as unknown };
  } catch (error) {
    const e = error as {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    };
    return { status: e.getStatus(), code: e.getResponse().code };
  }
};

const CYRILLIC = 'Ассалому алайкум, IELTS курс керак эди';
const steps = (): ScriptStep[] => [
  extraction({ subject: 'IELTS' }, 'search', 'uz', 'Cyrl'),
  {
    kind: 'tools',
    text: 'Сизга {{F1}} курси мос келади. Онлайн ёки марказда ўқийсизми?',
  },
];

describe('assistant test chat API (ADR 065)', () => {
  it('returns the reply, what was looked up and the collected details, and writes nothing', async () => {
    const tenantId = await tenantOnly();
    const controller = new TestChatController(
      service(new ScriptedLlmProvider([...steps(), ...steps()])),
      database,
    );
    const answer = await controller.send(as(tenantId, 'ADMIN'), {
      sessionId: randomUUID(),
      text: CYRILLIC,
    });
    expect(answer).toMatchObject({
      outcome: 'ANSWERED',
      handover: null,
      language: 'uz',
      script: 'Cyrl',
    });
    expect(answer.reply).toContain('IELTS Preparation');
    expect(answer.slots.subject).toMatchObject({ value: 'IELTS' });
    expect(answer.toolsUsed.length).toBeGreaterThan(0);
    for (const table of [
      prisma.conversation,
      prisma.contact,
      prisma.message,
      prisma.lead,
      prisma.handover,
      prisma.agentTurn,
    ])
      expect(
        await (
          table as never as { count: (a: object) => Promise<number> }
        ).count({ where: { tenantId } }),
      ).toBe(0);
    // The first message of a chat leaves one counts-only audit row, no text.
    const audit = await prisma.auditEvent.findMany({
      where: { tenantId, action: 'assistant.test_chat_used' },
    });
    expect(audit).toHaveLength(1);
    // A later message of the same chat (history present) adds none.
    await controller.send(as(tenantId, 'ADMIN'), {
      sessionId: randomUUID(),
      text: CYRILLIC,
      history: [{ role: 'customer', text: 'hello' }],
    });
    expect(
      await prisma.auditEvent.count({
        where: { tenantId, action: 'assistant.test_chat_used' },
      }),
    ).toBe(1);
    expect(JSON.stringify(audit[0]!.safeInputSummary)).not.toContain('IELTS');
  });

  it('only an owner or admin may use it, and a bad body is refused before any model call', async () => {
    const tenantId = await tenantOnly();
    const provider = new ScriptedLlmProvider(steps());
    const controller = new TestChatController(service(provider), database);
    const valid = { sessionId: randomUUID(), text: 'Hello' };
    for (const role of ['OPERATOR', 'VIEWER'] as Role[])
      expect(
        (await call(() => controller.send(as(tenantId, role), valid))).status,
      ).toBe(403);
    const bad = [
      {},
      { ...valid, text: '' },
      { ...valid, text: 'x'.repeat(1001) },
      { ...valid, sessionId: 'nope' },
      { ...valid, extra: 1 },
      {
        ...valid,
        history: Array.from({ length: 31 }, () => ({
          role: 'customer',
          text: 'a',
        })),
      },
      { ...valid, history: [{ role: 'system', text: 'a' }] },
      { ...valid, slots: { a: { value: 'x', source: 'admin' } } },
    ];
    for (const body of bad)
      expect(
        await call(() => controller.send(as(tenantId, 'OWNER'), body)),
      ).toEqual({
        status: 400,
        code: 'INVALID_BODY',
      });
    expect(await prisma.llmUsageRecord.count({ where: { tenantId } })).toBe(0);
  });

  it('limits each person to ten messages a minute, and others are not affected', async () => {
    const tenantId = await tenantOnly();
    const controller = new TestChatController(
      service(
        new ScriptedLlmProvider(
          Array.from({ length: 24 }, () =>
            extraction({}, 'greeting', 'en', 'Latn'),
          ),
        ),
      ),
      database,
    );
    const person = randomUUID();
    const body = {
      sessionId: randomUUID(),
      text: 'Hello',
      history: [{ role: 'customer', text: 'hi' }],
    };
    let refused = 0;
    for (let i = 0; i < 11; i += 1) {
      const result = await call(() =>
        controller.send(as(tenantId, 'ADMIN', person), body),
      );
      if (result.status === 429) {
        refused += 1;
        expect(result.code).toBe('TEST_CHAT_RATE_LIMITED');
      }
    }
    expect(refused).toBe(1);
    // Someone else is not limited by this person's messages.
    expect(
      (await call(() => controller.send(as(tenantId, 'ADMIN'), body))).code,
    ).not.toBe('TEST_CHAT_RATE_LIMITED');
  });

  it('reports a workspace the assistant cannot serve as a configuration problem', async () => {
    const tenantId = await tenantOnly();
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { supportedLocales: [] },
    });
    const controller = new TestChatController(
      service(new ScriptedLlmProvider([])),
      database,
    );
    expect(
      await call(() =>
        controller.send(as(tenantId, 'ADMIN'), {
          sessionId: randomUUID(),
          text: 'Hello',
        }),
      ),
    ).toEqual({ status: 400, code: 'AGENT_NOT_CONFIGURED' });
  });
});
