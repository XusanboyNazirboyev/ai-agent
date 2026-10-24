import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { DomainPack } from '@agentcore/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AgentConversationService } from '../agent/agent-conversation.service.js';
import { LlmBudgetLedger } from '../agent/llm-budget-ledger.js';
import { LlmUsageStore } from '../agent/llm-usage.store.js';
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
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { TRAVEL_PACK } from '../packs/travel/travel.pack.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { ActionService } from './action.service.js';

/**
 * Phase 7.1 conformance: two tenants of materially different domains use the
 * SAME pipeline, agent core and action engine instances in one process. The
 * domains differ only by pack data, tenant configuration and connector.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => db.$disconnect());

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
const consent = (text: string): Record<string, string> => ({
  'uz-Latn': text,
  'uz-Cyrl': text,
  ru: text,
  en: text,
});

const extractionFor = (
  pack: DomainPack,
  slots: Record<string, string>,
): ScriptStep => ({
  kind: 'structured',
  value: {
    language: 'uz',
    script: 'Latn',
    intent: 'booking_interest',
    slots: {
      ...Object.fromEntries(pack.slots.map((slot) => [slot.key, null])),
      ...slots,
    },
  },
});

// One process: one provider, one loader, one action engine, one pipeline.
const scripts = new Map<string, ScriptStep>();
const provider = new ScriptedLlmProvider((call: ScriptRequest): ScriptStep => {
  if (call.type !== 'structured') return { kind: 'tools', text: '' };
  const system = call.request.system ?? '';
  return (
    [...scripts.entries()].find(([marker]) => system.includes(marker))?.[1] ?? {
      kind: 'structured',
      failure: 'malformed',
    }
  );
});
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
  {
    nodeEnv: 'development',
    operatorNotifierConfigured: false,
    providerTrusted: true,
    allowRealCustomerData: false,
  },
  handovers,
  undefined,
  actions,
);
const processor = new TelegramProcessor(
  prisma,
  { sendMessage: vi.fn() } as unknown as TelegramSender,
  pipeline,
  undefined,
  undefined,
  undefined,
  undefined,
  actions,
);

scripts.set(
  'course consultant',
  extractionFor(EDUCATION_PACK, { subject: 'IELTS', preferredTime: 'evening' }),
);
scripts.set(
  'travel consultant',
  extractionFor(TRAVEL_PACK, {
    destination: 'Antalya',
    travelMonth: 'july',
    partySize: '2',
  }),
);

async function tenant(
  pack: DomainPack,
  sourceSystem: string,
  actionKey: string,
): Promise<{
  tenantId: string;
  accountId: string;
  webhook: TelegramWebhookService;
}> {
  const suffix = randomUUID();
  const created = await db.tenant.create({
    data: {
      slug: `x-${pack.key}-${suffix}`,
      name: `Cross-domain ${pack.key}`,
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
      timezone: 'Asia/Tashkent',
      packKey: pack.key,
      packVersion: pack.version,
      config: {
        actions: {
          [actionKey]: {
            mode: 'live',
            consent: consent(`${pack.key} consent text`),
          },
        },
      } as never,
    },
  });
  await db.tenantConnector.create({
    data: {
      tenantId: created.id,
      connectorKey: 'mock',
      status: 'ACTIVE',
      config: { sourceSystem },
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: created.id,
      channelType: 'telegram',
      externalAccountId: `x-${suffix}`,
      status: 'ACTIVE',
      agentMode: 'LIVE',
      isTestAccount: true,
    },
  });
  const webhook = new TelegramWebhookService(prisma, {
    get: (key: string) =>
      ({
        TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
        TELEGRAM_WEBHOOK_SECRET: 's',
        TELEGRAM_RATE_LIMIT_PER_MINUTE: 1_000,
      })[key],
  } as never);
  return { tenantId: created.id, accountId: account.id, webhook };
}

let update = 950_000;
async function say(
  t: Awaited<ReturnType<typeof tenant>>,
  text: string,
): Promise<string> {
  const id = ++update;
  const normalized = normalizeTelegramUpdate({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 6262 },
      from: { id: 62 },
      text,
    },
  });
  if (normalized.kind !== 'text') throw new Error('text');
  await t.webhook.accept(t.accountId, normalized);
  const outbox = await db.outboxEvent.findFirstOrThrow({
    where: {
      tenantId: t.tenantId,
      idempotencyKey: `telegram.inbound:${t.accountId}:${id}`,
    },
  });
  await processor.process({
    outboxId: outbox.id,
    tenantId: t.tenantId,
    type: outbox.type,
    payload: outbox.payload,
  });
  const last = await db.message.findFirstOrThrow({
    where: { tenantId: t.tenantId, direction: 'OUTBOUND' },
    orderBy: { sequence: 'desc' },
  });
  return last.text;
}

async function execute(t: Awaited<ReturnType<typeof tenant>>): Promise<string> {
  for (const event of await db.outboxEvent.findMany({
    where: { tenantId: t.tenantId, type: 'action.execute' },
  }))
    await processor.process({
      outboxId: event.id,
      tenantId: t.tenantId,
      type: event.type,
      payload: event.payload,
    });
  const last = await db.message.findFirstOrThrow({
    where: { tenantId: t.tenantId, direction: 'OUTBOUND' },
    orderBy: { sequence: 'desc' },
  });
  return last.text;
}

const auditTrail = async (tenantId: string): Promise<string[]> =>
  (
    await db.auditEvent.findMany({
      where: { tenantId, entityType: 'action_proposal' },
      orderBy: { createdAt: 'asc' },
    })
  ).map((a) => a.action);

describe('two domains, one action engine', () => {
  it('education and travel run different actions through the same lifecycle, isolated', async () => {
    const education = await tenant(
      EDUCATION_PACK,
      'mock-education',
      'course_enquiry',
    );
    const travel = await tenant(TRAVEL_PACK, 'mock-tourism', 'trip_request');

    // Different required data: education asks a phone; travel asks a name, then a phone.
    expect(await say(education, 'IELTS kechqurun yozilmoqchiman')).toBe(
      UZ_LATN.templates.phoneRequest,
    );
    expect(await say(travel, 'Antalyaga iyulda 2 kishi bormoqchimiz')).toBe(
      UZ_LATN.templates.actions.askName,
    );
    expect(await say(travel, 'Ali Valiyev')).toBe(
      UZ_LATN.templates.phoneRequest,
    );

    const eduProposal = await say(education, '+998 90 111 22 33');
    const travelProposal = await say(travel, '+998 90 444 55 66');
    expect(eduProposal).toContain('kursga yozilish so‘rovi');
    expect(eduProposal).toContain('education consent text');
    expect(travelProposal).toContain('sayohat so‘rovi');
    expect(travelProposal).toContain('Antalya');
    expect(travelProposal).toContain('Ali Valiyev');
    expect(travelProposal).toContain('travel consent text');

    const [eduRow, travelRow] = await Promise.all([
      db.actionProposal.findFirstOrThrow({
        where: { tenantId: education.tenantId, status: 'PROPOSED' },
      }),
      db.actionProposal.findFirstOrThrow({
        where: { tenantId: travel.tenantId, status: 'PROPOSED' },
      }),
    ]);
    expect(Object.keys(eduRow.payload as object).sort()).toEqual([
      'contact.phone',
      'slots.preferredTime',
      'slots.subject',
    ]);
    expect(Object.keys(travelRow.payload as object).sort()).toEqual([
      'contact.name',
      'contact.phone',
      'slots.destination',
      'slots.partySize',
      'slots.travelMonth',
    ]);

    // Confirmations are per conversation and per tenant.
    expect(await say(education, 'ha')).toBe(UZ_LATN.templates.actions.received);
    expect(await say(travel, 'ha')).toBe(UZ_LATN.templates.actions.received);

    expect(await execute(education)).toBe(UZ_LATN.templates.actions.succeeded);
    const travelOutcome = await execute(travel);
    const travelDone = await db.actionProposal.findUniqueOrThrow({
      where: { id: travelRow.id },
    });
    expect(travelDone.externalId).toMatch(/^mock-tourism:lead:\d+$/u);
    // The travel pack shows the reference; the education pack does not.
    expect(travelOutcome).toBe(
      UZ_LATN.templates.actions.succeededWithReference.replace(
        '{reference}',
        travelDone.externalId!,
      ),
    );
    expect(
      (await db.actionProposal.findUniqueOrThrow({ where: { id: eduRow.id } }))
        .externalId,
    ).toMatch(/^mock-education:lead:\d+$/u);

    // The same lifecycle, step by step, for both domains.
    const expected = [
      'action.proposed',
      'action.confirmed',
      'action.succeeded',
    ];
    expect(await auditTrail(education.tenantId)).toEqual(expected);
    expect(await auditTrail(travel.tenantId)).toEqual(expected);
    // Nothing crosses tenants.
    expect(
      await db.actionProposal.count({
        where: { tenantId: education.tenantId, actionKey: 'trip_request' },
      }),
    ).toBe(0);
    expect(
      await db.actionProposal.count({
        where: { tenantId: travel.tenantId, actionKey: 'course_enquiry' },
      }),
    ).toBe(0);
  });
});
