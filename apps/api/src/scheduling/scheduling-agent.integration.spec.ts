import type { ConfigService } from '@nestjs/config';
import type { DomainPack } from '@agentcore/shared';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ActionService } from '../actions/action.service.js';
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
import { retireOutbox } from '../channels/telegram/testing/outbox.js';
import { createConnectorRegistry } from '../connectors/connectors.module.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import {
  ScriptedLlmProvider,
  type ScriptRequest,
  type ScriptStep,
} from '../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { HandoverService } from '../handover/handover.service.js';
import { EN } from '../locales/locale-packs.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AppointmentService } from './appointment.service.js';
import { SchedulingActionsService } from './scheduling-actions.service.js';
import { SCHEDULING_TEST_PACK } from './testing/scheduling-test-pack.js';

/**
 * ADR 046 step 2 through the real pipeline: webhook intake -> agent turn with
 * the scheduling tools -> code-rendered proposal -> code-detected "yes"/"no"
 * -> appointment state, with a scripted model.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
(DOMAIN_PACKS as Map<string, DomainPack>).set(
  `${SCHEDULING_TEST_PACK.key}@${SCHEDULING_TEST_PACK.version}`,
  SCHEDULING_TEST_PACK,
);
const createdTenants: string[] = [];
afterAll(async () => {
  await retireOutbox(db, createdTenants);
  await db.$disconnect();
});

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

/** What the scripted model does in its next tool round. */
type Plan = 'idle' | 'find' | 'book' | 'cancel' | 'reschedule';
const plan: { current: Plan; date: string } = { current: 'find', date: '' };

function tomorrow(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
  }).format(new Date(Date.now() + 36 * 3_600_000));
}

function responder(call: ScriptRequest): ScriptStep {
  if (call.type === 'structured')
    return extraction({}, 'booking_interest', 'en', 'Latn');
  if (plan.current === 'idle') return { kind: 'tools', text: 'Hello!' };
  const messages = call.request.messages;
  const last = messages.at(-1)!;
  const first = messages[0];
  const firstText = first.role === 'user' ? first.text : '';
  const bookingId = /"bookingId":"([^"]+)"/u.exec(firstText)?.[1] ?? 'none';
  const resultText =
    last.role === 'tool_results'
      ? last.results.map((r) => r.content).join('')
      : '';
  const slotId = /"slotId":"([^"]+)"/u.exec(resultText)?.[1];
  if (last.role !== 'tool_results') {
    if (plan.current === 'cancel')
      return {
        kind: 'tools',
        toolCalls: [{ name: 'cancel_booking', input: { bookingId } }],
      };
    return {
      kind: 'tools',
      toolCalls: [
        {
          name: 'find_slots',
          input: { serviceKey: 'visit', preferredDate: plan.date },
        },
      ],
    };
  }
  if (plan.current === 'book' && slotId)
    return {
      kind: 'tools',
      toolCalls: [{ name: 'book_slot', input: { slotId } }],
    };
  if (plan.current === 'reschedule' && slotId)
    return {
      kind: 'tools',
      toolCalls: [{ name: 'reschedule_booking', input: { bookingId, slotId } }],
    };
  const when = /"whenFact":"(F\d+)"/u.exec(resultText)?.[1];
  const staff = /"staffFact":"(F\d+)"/u.exec(resultText)?.[1];
  return {
    kind: 'tools',
    text:
      when && staff ? `Free: {{${when}}} with {{${staff}}}.` : 'Nothing free.',
  };
}

async function fixture(): Promise<{
  tenantId: string;
  accountId: string;
  contactId: string;
  conversationId: string;
  webhook: TelegramWebhookService;
  processor: TelegramProcessor;
  serviceId: string;
  staffId: string;
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `sched-agent-${suffix}`,
      name: 'Scheduling agent',
      defaultLocale: 'en',
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
      timezone: 'Asia/Tashkent',
      packKey: SCHEDULING_TEST_PACK.key,
      packVersion: SCHEDULING_TEST_PACK.version,
    },
  });
  createdTenants.push(tenant.id);
  await db.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: 'mock',
      status: 'ACTIVE',
      config: { sourceSystem: 'mock-education' },
    },
  });
  const staff = await db.staffMember.create({
    data: { tenantId: tenant.id, displayName: 'Aziza', skills: ['repair'] },
  });
  await db.availabilityRule.createMany({
    data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      tenantId: tenant.id,
      staffMemberId: staff.id,
      weekday,
      startTime: '09:00',
      endTime: '18:00',
    })),
  });
  const service = await db.serviceType.create({
    data: {
      tenantId: tenant.id,
      key: 'visit',
      title: 'Home visit',
      durationMinutes: 60,
      leadTimeMinutes: 60,
      requiredSkills: ['repair'],
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `sched-agent-${suffix}`,
      status: 'ACTIVE',
      agentMode: 'LIVE',
      isTestAccount: true,
    },
  });
  const provider = new ScriptedLlmProvider(responder);
  const loader = new TenantConnectorLoader(
    prisma,
    createConnectorRegistry({
      NODE_ENV: 'test',
      CONNECTOR_OUTBOUND_POLICY: 'strict',
    }),
  );
  const handovers = new HandoverService(prisma);
  const scheduling = new SchedulingActionsService(
    prisma,
    new AppointmentService(prisma),
  );
  const actions = new ActionService(prisma, loader, handovers, cfg, scheduling);
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
    scheduling,
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
  const webhook = new TelegramWebhookService(prisma, {
    get: (key: string) =>
      ({
        TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
        TELEGRAM_WEBHOOK_SECRET: 's',
        TELEGRAM_RATE_LIMIT_PER_MINUTE: 1_000,
      })[key],
  } as never);
  const f = {
    tenantId: tenant.id,
    accountId: account.id,
    contactId: '',
    conversationId: '',
    webhook,
    processor,
    serviceId: service.id,
    staffId: staff.id,
  };
  plan.current = 'idle';
  await say(f, 'hello');
  const conversation = await db.conversation.findFirstOrThrow({
    where: { tenantId: tenant.id },
  });
  f.contactId = conversation.contactId;
  f.conversationId = conversation.id;
  return f;
}
type Fx = Awaited<ReturnType<typeof fixture>>;

let nextUpdate = 930_000;
async function say(
  f: Pick<Fx, 'tenantId' | 'accountId' | 'webhook' | 'processor'>,
  text: string,
): Promise<void> {
  const updateId = ++nextUpdate;
  const normalized = normalizeTelegramUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 5252 },
      from: { id: 52 },
      text,
    },
  });
  if (normalized.kind !== 'text') throw new Error('expected text');
  await f.webhook.accept(f.accountId, normalized);
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

const lastReply = async (tenantId: string): Promise<string> =>
  (
    await db.message.findMany({
      where: { tenantId, direction: 'OUTBOUND' },
      orderBy: { sequence: 'desc' },
      take: 1,
    })
  )[0].text;

const appointments = (tenantId: string) =>
  db.appointment.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });

async function bookHeld(f: Fx): Promise<void> {
  plan.current = 'book';
  plan.date = tomorrow();
  await say(f, 'I want to book a home visit tomorrow');
}

describe('agent scheduling through the real pipeline', () => {
  it('find -> book holds a slot; "yes" confirms it (code-detected)', async () => {
    const f = await fixture();
    plan.current = 'find';
    plan.date = tomorrow();
    await say(f, 'I want to book a home visit tomorrow');
    expect(await lastReply(f.tenantId)).toMatch(/Free: .*Aziza/u);
    expect(await appointments(f.tenantId)).toHaveLength(0);

    await bookHeld(f);
    const proposal = await lastReply(f.tenantId);
    expect(proposal).toContain('Please confirm your appointment');
    expect(proposal).toContain('Aziza');
    const [held] = await appointments(f.tenantId);
    expect(held.status).toBe('HELD');
    expect(held.contactId).toBe(f.contactId);

    await say(f, 'yes');
    expect((await appointments(f.tenantId))[0].status).toBe('CONFIRMED');
    expect(await lastReply(f.tenantId)).toBe(
      EN.templates.scheduling.booked
        .replace('{service}', 'Home visit')
        .replace('{staff}', 'Aziza')
        .replace(
          '{when}',
          new Intl.DateTimeFormat(EN.intlLocale, {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Asia/Tashkent',
          }).format(held.startsAt),
        ),
    );
  });

  it('"no" releases the hold', async () => {
    const f = await fixture();
    await bookHeld(f);
    await say(f, 'no');
    const [row] = await appointments(f.tenantId);
    expect(row.status).toBe('CANCELLED');
    expect(await lastReply(f.tenantId)).toBe(EN.templates.scheduling.released);
  });

  it('a lapsed hold on "yes" answers with the template and does not book', async () => {
    const f = await fixture();
    await bookHeld(f);
    const past = new Date(Date.now() - 60_000);
    await db.appointment.updateMany({
      where: { tenantId: f.tenantId },
      data: { holdExpiresAt: past },
    });
    await db.actionProposal.updateMany({
      where: { tenantId: f.tenantId },
      data: { expiresAt: past },
    });
    await say(f, 'yes');
    expect((await appointments(f.tenantId))[0].status).not.toBe('CONFIRMED');
    expect(await lastReply(f.tenantId)).toBe(
      EN.templates.scheduling.holdExpired,
    );
  });

  it('cancels a confirmed appointment only after confirmation', async () => {
    const f = await fixture();
    await bookHeld(f);
    await say(f, 'yes');
    plan.current = 'cancel';
    await say(f, 'please cancel my visit');
    expect(await lastReply(f.tenantId)).toContain('Cancel your appointment');
    expect((await appointments(f.tenantId))[0].status).toBe('CONFIRMED');
    await say(f, 'yes');
    expect((await appointments(f.tenantId))[0].status).toBe('CANCELLED');
  });

  it('reschedules atomically: old stays until the new one is confirmed', async () => {
    const f = await fixture();
    await bookHeld(f);
    await say(f, 'yes');
    plan.current = 'reschedule';
    await say(f, 'move my visit to another time');
    let rows = await appointments(f.tenantId);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('CONFIRMED');
    expect(rows[1].status).toBe('HELD');
    await say(f, 'yes');
    rows = await appointments(f.tenantId);
    expect(rows.map((r) => r.status)).toEqual(['CANCELLED', 'CONFIRMED']);
  });

  it('reschedule declined keeps the old appointment and frees the new hold', async () => {
    const f = await fixture();
    await bookHeld(f);
    await say(f, 'yes');
    plan.current = 'reschedule';
    await say(f, 'move my visit to another time');
    await say(f, 'no');
    const rows = await appointments(f.tenantId);
    expect(rows.map((r) => r.status)).toEqual(['CONFIRMED', 'CANCELLED']);
  });

  it('is tenant- and customer-isolated', async () => {
    const a = await fixture();
    await bookHeld(a);
    await say(a, 'yes');
    const [appt] = await appointments(a.tenantId);
    const b = await fixture();
    const svc = new SchedulingActionsService(
      prisma,
      new AppointmentService(prisma),
    );
    const portB = await svc.portFor({
      tenantId: b.tenantId,
      conversationId: b.conversationId,
      turnKey: 'x',
      timeZone: 'Asia/Tashkent',
    });
    expect(await portB!.upcoming()).toHaveLength(0);
    expect(await portB!.prepareCancel(appt.id)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    // another contact of the same tenant cannot touch it either
    const other = await db.contact.create({
      data: {
        tenantId: a.tenantId,
        channelAccountId: a.accountId,
        providerUserId: 'other-user',
      },
    });
    const conv = await db.conversation.create({
      data: {
        tenantId: a.tenantId,
        channelAccountId: a.accountId,
        contactId: other.id,
        providerChatId: 'other-chat',
      },
    });
    const portO = await svc.portFor({
      tenantId: a.tenantId,
      conversationId: conv.id,
      turnKey: 'y',
      timeZone: 'Asia/Tashkent',
    });
    expect(await portO!.prepareCancel(appt.id)).toMatchObject({ ok: false });
    expect(await portO!.hold('forged-slot-id')).toMatchObject({ ok: false });
  });
});
