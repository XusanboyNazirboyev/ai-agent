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
import { SuggestReplyController } from './suggest-reply.controller.js';
import { LlmBudgetLedger } from '../agent/llm-budget-ledger.js';
import { LlmUsageStore } from '../agent/llm-usage.store.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Suggest reply tests require agentcore_test');
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

async function conversationOf(
  tenantId: string,
  options: {
    state?: 'BOT_ACTIVE' | 'WAITING_OPERATOR' | 'CLOSED';
    messages: Array<['CUSTOMER' | 'BOT' | 'OPERATOR', string]>;
  },
) {
  const suffix = randomUUID();
  const account = await prisma.channelAccount.create({
    data: {
      tenantId,
      channelType: 'telegram',
      externalAccountId: `sug-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await prisma.contact.create({
    data: {
      tenantId,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Customer',
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      tenantId,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      state: options.state ?? 'WAITING_OPERATOR',
    },
  });
  const ids: string[] = [];
  let sequence = 0;
  for (const [authorType, text] of options.messages) {
    sequence += 1;
    const message = await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        channelAccountId: account.id,
        authorType,
        direction: authorType === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND',
        text,
        sequence,
        providerChatId: `c-${suffix}`,
      },
    });
    ids.push(message.id);
  }
  return { conversationId: conversation.id, messageIds: ids };
}

const counts = async (tenantId: string) => ({
  messages: await prisma.message.count({ where: { tenantId } }),
  turns: await prisma.agentTurn.count({ where: { tenantId } }),
  handovers: await prisma.handover.count({ where: { tenantId } }),
  leads: await prisma.lead.count({ where: { tenantId } }),
  slots: await prisma.conversationSlots.count({ where: { tenantId } }),
});

const answerSteps = (): ScriptStep[] => [
  extraction({ subject: 'IELTS' }, 'search', 'uz', 'Cyrl'),
  {
    kind: 'tools',
    text: 'Сизга {{F1}} курси мос келади. Онлайн ёки марказда ўқийсизми?',
  },
];

describe('assistant suggestion for an operator (ADR 066)', () => {
  it('drafts an answer to the last customer message and changes nothing', async () => {
    const tenantId = await tenantOnly();
    const convo = await conversationOf(tenantId, {
      messages: [
        ['CUSTOMER', 'Salom'],
        ['BOT', 'Assalomu alaykum!'],
        ['CUSTOMER', CYRILLIC],
        ['BOT', 'A later message that is not the customer'],
      ],
    });
    const controller = new SuggestReplyController(
      service(new ScriptedLlmProvider(answerSteps())),
      database,
    );
    const before = await counts(tenantId);
    const out = await controller.suggest(
      as(tenantId, 'OPERATOR'),
      convo.conversationId,
    );
    expect(out.reply).toContain('IELTS Preparation');
    expect(out.handover).toBeNull();
    expect(out.toolsUsed.length).toBeGreaterThan(0);
    // It answers the newest customer message, not the newest message.
    expect(out.basedOnMessageId).toBe(convo.messageIds[2]);
    // Read only: not one row of the conversation changed.
    expect(await counts(tenantId)).toEqual(before);
    // The cost is metered like any turn.
    const usage = await prisma.llmUsageRecord.findMany({ where: { tenantId } });
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((row) => row.turnKey.startsWith('suggest-'))).toBe(true);
  });

  it('gives no draft when the assistant itself would hand the chat over, and says why', async () => {
    const tenantId = await tenantOnly();
    const convo = await conversationOf(tenantId, {
      messages: [['CUSTOMER', 'Hello, I want to talk to a person']],
    });
    const controller = new SuggestReplyController(
      service(
        new ScriptedLlmProvider([
          extraction({}, 'human_request', 'en', 'Latn'),
        ]),
      ),
      database,
    );
    const out = await controller.suggest(
      as(tenantId, 'ADMIN'),
      convo.conversationId,
    );
    expect(out.reply).toBeNull();
    expect(out.handover).toBe('CUSTOMER_REQUEST');
  });

  it('refuses a viewer, another workspace, a closed chat and a chat with nothing to answer', async () => {
    const tenantId = await tenantOnly();
    const other = await tenantOnly();
    const open = await conversationOf(tenantId, {
      messages: [['CUSTOMER', 'Hello']],
    });
    const closed = await conversationOf(tenantId, {
      state: 'CLOSED',
      messages: [['CUSTOMER', 'Hello']],
    });
    const botOnly = await conversationOf(tenantId, {
      messages: [['BOT', 'Welcome']],
    });
    const provider = new ScriptedLlmProvider(answerSteps());
    const controller = new SuggestReplyController(service(provider), database);
    expect(
      (
        await call(() =>
          controller.suggest(as(tenantId, 'VIEWER'), open.conversationId),
        )
      ).status,
    ).toBe(403);
    expect(
      await call(() =>
        controller.suggest(as(other, 'ADMIN'), open.conversationId),
      ),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(
      await call(() =>
        controller.suggest(as(tenantId, 'ADMIN'), closed.conversationId),
      ),
    ).toEqual({ status: 409, code: 'CONVERSATION_CLOSED' });
    expect(
      await call(() =>
        controller.suggest(as(tenantId, 'ADMIN'), botOnly.conversationId),
      ),
    ).toEqual({ status: 400, code: 'NO_CUSTOMER_MESSAGE' });
    // None of the refusals reached the model.
    expect(await prisma.llmUsageRecord.count({ where: { tenantId } })).toBe(0);
  });

  it('limits one person to six suggestions a minute', async () => {
    const tenantId = await tenantOnly();
    const convo = await conversationOf(tenantId, {
      messages: [['CUSTOMER', 'Hello']],
    });
    const controller = new SuggestReplyController(
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
    let refused = 0;
    for (let i = 0; i < 7; i += 1) {
      const result = await call(() =>
        controller.suggest(
          as(tenantId, 'OPERATOR', person),
          convo.conversationId,
        ),
      );
      if (result.status === 429) {
        refused += 1;
        expect(result.code).toBe('SUGGEST_RATE_LIMITED');
      }
    }
    expect(refused).toBe(1);
  });
});
