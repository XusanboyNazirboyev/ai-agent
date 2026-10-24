import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AgentConversationService } from '../agent/agent-conversation.service.js';
import type { AgentModePolicy } from '../agent/agent-mode.js';
import { LlmBudgetLedger } from '../agent/llm-budget-ledger.js';
import { LlmUsageStore } from '../agent/llm-usage.store.js';
import { extraction } from '../agent/testing/agent-harness.js';
import type { AppEnvironment } from '../config/environment.js';
import { TelegramAgentPipeline } from '../channels/telegram/telegram-agent-pipeline.js';
import { normalizeTelegramUpdate } from '../channels/telegram/telegram-normalizer.js';
import { TelegramProcessor } from '../channels/telegram/telegram-processor.js';
import type { TelegramSender } from '../channels/telegram/telegram-sender.js';
import { TelegramWebhookService } from '../channels/telegram/telegram-webhook.service.js';
import { createConnectorRegistry } from '../connectors/connectors.module.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import {
  ScriptedLlmProvider,
  type ScriptRequest,
  type ScriptStep,
} from '../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { HandoverService } from '../handover/handover.service.js';
import { UZ_LATN } from '../locales/locale-packs.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { ActionService } from './action.service.js';

/**
 * The whole action lifecycle through the real pipeline: webhook intake ->
 * agent turn -> commit -> outbox -> execution through the registered mock
 * connector (native idempotency) -> code-rendered outcome message.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => db.$disconnect());

const DEV: AgentModePolicy = {
  nodeEnv: 'development',
  operatorNotifierConfigured: false,
  providerTrusted: true,
  allowRealCustomerData: false,
};
const settings: Record<string, unknown> = {
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
  HANDOVER_SLA_MINUTES: 10,
};
const cfg = { get: (key: string) => settings[key] } as unknown as ConfigService<
  AppEnvironment,
  true
>;
const CONSENT = {
  'uz-Latn': 'Raqamingiz markazga yuboriladi.',
  'uz-Cyrl': 'Рақамингиз марказга юборилади.',
  ru: 'Номер будет передан центру.',
  en: 'Your number is sent to the centre.',
};

async function fixture(mode: 'LIVE' | 'SHADOW'): Promise<{
  tenantId: string;
  accountId: string;
  webhook: TelegramWebhookService;
  processor: TelegramProcessor;
  provider: ScriptedLlmProvider;
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `act-pipe-${suffix}`,
      name: 'Action pipeline',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
      config: {
        actions: { course_enquiry: { mode: 'live', consent: CONSENT } },
      } as never,
    },
  });
  await db.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: 'mock',
      status: 'ACTIVE',
      config: { sourceSystem: 'mock-education' },
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `act-pipe-${suffix}`,
      status: 'ACTIVE',
      agentMode: mode,
      isTestAccount: true,
    },
  });
  const provider = new ScriptedLlmProvider((call: ScriptRequest): ScriptStep =>
    call.type === 'structured'
      ? extraction(
          { subject: 'IELTS', preferredTime: 'morning' },
          'booking_interest',
        )
      : { kind: 'tools', text: 'Sizga {{F1}} mos.' },
  );
  const loader = new TenantConnectorLoader(
    prisma,
    createConnectorRegistry({
      NODE_ENV: 'test',
      CONNECTOR_OUTBOUND_POLICY: 'strict',
    }),
  );
  const handovers = new HandoverService(prisma);
  const actions = new ActionService(prisma, loader, handovers, cfg);
  const agent = new AgentConversationService(
    prisma,
    loader,
    new LlmUsageStore(prisma),
    new LlmBudgetLedger(prisma),
    provider,
    cfg,
    undefined,
    undefined,
    actions,
  );
  const pipeline = new TelegramAgentPipeline(
    prisma,
    agent,
    cfg,
    DEV,
    handovers,
    undefined,
    actions,
  );
  const sender = { sendMessage: vi.fn() };
  const processor = new TelegramProcessor(
    prisma,
    sender as unknown as TelegramSender,
    pipeline,
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  const webhook = new TelegramWebhookService(prisma, {
    get: (key: string) =>
      ({
        TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
        TELEGRAM_WEBHOOK_SECRET: 's',
        TELEGRAM_RATE_LIMIT_PER_MINUTE: 1_000,
      })[key],
  } as never);
  return {
    tenantId: tenant.id,
    accountId: account.id,
    webhook,
    processor,
    provider,
  };
}

let nextUpdate = 910_000;
async function say(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  duplicate = false,
): Promise<void> {
  const updateId = duplicate ? nextUpdate : ++nextUpdate;
  const normalized = normalizeTelegramUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 5151 },
      from: { id: 51 },
      text,
    },
  });
  if (normalized.kind !== 'text') throw new Error('expected text');
  const accepted = await f.webhook.accept(f.accountId, normalized);
  if (duplicate) {
    expect(accepted).toBe('duplicate');
    return;
  }
  const outbox = await db.outboxEvent.findFirstOrThrow({
    where: {
      tenantId: f.tenantId,
      type: 'telegram.inbound',
      idempotencyKey: `telegram.inbound:${f.accountId}:${updateId}`,
    },
  });
  await f.processor.process({
    outboxId: outbox.id,
    tenantId: f.tenantId,
    type: outbox.type,
    payload: outbox.payload,
  });
}

async function runQueued(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<void> {
  const events = await db.outboxEvent.findMany({
    where: { tenantId: f.tenantId, type: 'action.execute' },
  });
  for (const event of events)
    await f.processor.process({
      outboxId: event.id,
      tenantId: f.tenantId,
      type: event.type,
      payload: event.payload,
    });
}

const replies = (tenantId: string): Promise<string[]> =>
  db.message
    .findMany({
      where: { tenantId, direction: 'OUTBOUND' },
      orderBy: { sequence: 'asc' },
    })
    .then((rows) => rows.map((r) => r.text));

describe('business action through the real pipeline (LIVE, development policy, mock connector)', () => {
  it('collects the phone, proposes, confirms once, executes and reports the verified outcome', async () => {
    const f = await fixture('LIVE');
    await say(f, 'IELTS ertalab yozilmoqchiman');
    expect((await replies(f.tenantId)).at(-1)).toBe(
      UZ_LATN.templates.phoneRequest,
    );

    await say(f, '+998 90 123 45 67');
    const proposal = await db.actionProposal.findFirstOrThrow({
      where: { tenantId: f.tenantId, status: 'PROPOSED' },
    });
    expect(proposal.payload).toEqual({
      'slots.subject': 'IELTS',
      'slots.preferredTime': 'morning',
      'contact.phone': '+998901234567',
    });
    const shown = (await replies(f.tenantId)).at(-1)!;
    expect(shown).toContain('IELTS');
    expect(shown).toContain('+998901234567');
    expect(shown).toContain(CONSENT['uz-Latn']);

    const callsBefore = f.provider.calls.length;
    await say(f, 'ha');
    expect(f.provider.calls.length).toBe(callsBefore); // confirmation never reaches the model
    expect((await replies(f.tenantId)).at(-1)).toBe(
      UZ_LATN.templates.actions.received,
    );
    // Telegram redelivers the same update: accepted once, no second confirmation.
    await say(f, 'ha', true);
    expect(
      await db.connectorOperation.count({ where: { tenantId: f.tenantId } }),
    ).toBe(1);

    await runQueued(f);
    await runQueued(f); // a redelivered queue job changes nothing
    const done = await db.actionProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(done.status).toBe('SUCCEEDED');
    expect(done.externalId).toMatch(/^mock-education:lead:\d+$/u);
    expect(done.payload).toBeNull();
    const all = await replies(f.tenantId);
    expect(all.at(-1)).toBe(UZ_LATN.templates.actions.succeeded);
    expect(
      all.filter((text) => text === UZ_LATN.templates.actions.succeeded),
    ).toHaveLength(1);
  });

  it('SHADOW proposes and executes nothing, and sends nothing', async () => {
    const f = await fixture('SHADOW');
    await say(f, 'IELTS ertalab yozilmoqchiman');
    await say(f, '+998 90 123 45 67');
    await say(f, 'ha');
    expect(
      await db.actionProposal.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
    expect(
      await db.connectorOperation.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
    expect(await replies(f.tenantId)).toEqual([]);
  });
});
