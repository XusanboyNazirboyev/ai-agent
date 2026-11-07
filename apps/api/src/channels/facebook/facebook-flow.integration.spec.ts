import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AgentConversationService } from '../../agent/agent-conversation.service.js';
import { agentModePolicy } from '../../agent/agent-mode.js';
import { LlmBudgetLedger } from '../../agent/llm-budget-ledger.js';
import { LlmUsageStore } from '../../agent/llm-usage.store.js';
import { extraction } from '../../agent/testing/agent-harness.js';
import type { AppEnvironment } from '../../config/environment.js';
import { createConnectorRegistry } from '../../connectors/connectors.module.js';
import { TenantConnectorLoader } from '../../connectors/sync/tenant-connector-loader.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../../core/llm/scripted-llm-provider.js';
import { PrismaClient, type Message } from '../../generated/prisma/client.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { PrismaChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { createKeyring, SecretCipher } from '../../secrets/secret-cipher.js';
import { TelegramAgentPipeline } from '../telegram/telegram-agent-pipeline.js';
import {
  TelegramProcessor,
  type TelegramQueueEvent,
} from '../telegram/telegram-processor.js';
import type { TelegramSender } from '../telegram/telegram-sender.js';
import { InstagramGraphClient } from '../instagram/instagram-graph.js';
import { InstagramWebhookService } from '../instagram/instagram-webhook.service.js';
import { normalizeFacebookWebhook } from './facebook-normalizer.js';
import { FacebookSender } from './facebook-sender.js';

/**
 * Messenger end to end on the real database (ADR 040): durable webhook
 * intake -> `facebook.inbound` -> the shared agent pipeline -> the channel
 * send queue -> the Facebook sender with the messaging-window gate -> a fake
 * Meta Graph transport. No network, no real Meta credentials.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Messenger flow integration tests require agentcore_test');

const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => db.$disconnect());

const PRODUCTION = agentModePolicy({
  NODE_ENV: 'production',
  LLM_PROVIDER: 'mock',
  LLM_TRUSTED_PROVIDERS: ['mock'],
  LLM_ALLOW_REAL_CUSTOMER_DATA: false,
});
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
const cfg = {
  get: (key: string) => (settings as Record<string, unknown>)[key],
} as unknown as ConfigService<AppEnvironment, true>;

/** Fake values only; no real Meta credential or account is used. */
const TOKEN = `test-${randomBytes(16).toString('hex')}`;
/** Page-scoped id of the (fictional) customer. */
const CUSTOMER_ID = '2400000000000001';
const HOUR_MS = 60 * 60 * 1000;
const digits = (): string => `1000${randomInt(10 ** 9, 10 ** 10 - 1)}`;

type Meta = (
  url: string,
  init: RequestInit,
) => { status: number; body: unknown };
const sentOk: Meta = () => ({
  status: 200,
  body: { recipient_id: CUSTOMER_ID, message_id: `mid.${randomUUID()}` },
});

interface Fixture {
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly pageId: string;
  readonly intake: InstagramWebhookService;
  readonly processor: TelegramProcessor;
  readonly facebook: FacebookSender;
  readonly telegram: { sendMessage: ReturnType<typeof vi.fn> };
  readonly calls: { url: string; init: RequestInit }[];
  readonly provider: ScriptedLlmProvider;
}

async function fixture(options: {
  mode: 'OFF' | 'SHADOW' | 'LIVE';
  meta?: Meta;
  storeToken?: boolean;
}): Promise<Fixture> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `fb-flow-${suffix}`,
      name: 'Messenger flow fixture',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
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
  const pageId = digits();
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'facebook',
      externalAccountId: pageId,
      status: 'ACTIVE',
      agentMode: options.mode,
    },
  });
  const secrets = new PrismaChannelSecretStore(
    prisma,
    new SecretCipher(
      createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
    ),
  );
  if (options.storeToken !== false)
    await secrets.put(
      { tenantId: tenant.id, channelAccountId: account.id },
      'facebook_page_access_token',
      TOKEN,
    );
  const calls: { url: string; init: RequestInit }[] = [];
  const meta = options.meta ?? sentOk;
  const request = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = meta(String(url), init ?? {});
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  const provider = new ScriptedLlmProvider((call): ScriptStep =>
    call.type === 'structured'
      ? extraction({ subject: 'IELTS' })
      : { kind: 'tools', text: 'Sizga {{F1}} kursi mos keladi.' },
  );
  const agent = new AgentConversationService(
    prisma,
    new TenantConnectorLoader(
      prisma,
      createConnectorRegistry({
        NODE_ENV: 'test',
        CONNECTOR_OUTBOUND_POLICY: 'strict',
      }),
    ),
    new LlmUsageStore(prisma),
    new LlmBudgetLedger(prisma),
    provider,
    cfg,
  );
  const telegram = { sendMessage: vi.fn() };
  const facebook = new FacebookSender(
    prisma,
    new InstagramGraphClient(request as unknown as typeof fetch),
    secrets,
  );
  const processor = new TelegramProcessor(
    prisma,
    telegram as unknown as TelegramSender,
    new TelegramAgentPipeline(prisma, agent, cfg, PRODUCTION),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    facebook,
  );
  return {
    tenantId: tenant.id,
    channelAccountId: account.id,
    pageId,
    intake: new InstagramWebhookService(prisma),
    processor,
    facebook,
    telegram,
    calls,
    provider,
  };
}

let nextMid = 0;
/** A signed-and-verified delivery as the controller hands it to intake. */
async function receive(
  f: Fixture,
  text: string,
  customerId = CUSTOMER_ID,
): Promise<{ event: TelegramQueueEvent; mid: string }> {
  const mid = `mid.in.${++nextMid}.${randomUUID()}`;
  const normalized = normalizeFacebookWebhook(
    {
      object: 'page',
      entry: [
        {
          id: f.pageId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: customerId },
              recipient: { id: f.pageId },
              timestamp: Date.now(),
              message: { mid, text },
            },
          ],
        },
      ],
    },
    new Date(),
  );
  if (!normalized.ok || normalized.events[0]?.kind !== 'text')
    throw new Error('expected one text event');
  expect(await f.intake.accept(normalized.events[0], 'facebook')).toBe(
    'accepted',
  );
  const outbox = await db.outboxEvent.findFirstOrThrow({
    where: {
      tenantId: f.tenantId,
      type: 'facebook.inbound',
      idempotencyKey: `facebook.inbound:${f.channelAccountId}:${mid}`,
    },
  });
  return {
    mid,
    event: {
      outboxId: outbox.id,
      tenantId: f.tenantId,
      type: outbox.type,
      payload: outbox.payload,
    },
  };
}

/** The pending channel sends of this tenant, as queue events. */
async function sends(f: Fixture): Promise<TelegramQueueEvent[]> {
  const rows = await db.outboxEvent.findMany({
    where: { tenantId: f.tenantId, type: 'telegram.send' },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    outboxId: row.id,
    tenantId: row.tenantId,
    type: row.type,
    payload: row.payload,
  }));
}

async function outbound(f: Fixture): Promise<Message[]> {
  return db.message.findMany({
    where: { tenantId: f.tenantId, direction: 'OUTBOUND' },
    orderBy: { sequence: 'asc' },
  });
}

/** An outbound bot message queued for sending, without an agent turn. */
async function queueReply(
  f: Fixture,
  text: string,
  customerId = CUSTOMER_ID,
): Promise<{ message: Message; event: TelegramQueueEvent }> {
  const conversation = await db.conversation.findFirstOrThrow({
    where: { tenantId: f.tenantId, providerChatId: customerId },
  });
  const latest = await db.message.findFirst({
    where: { tenantId: f.tenantId, conversationId: conversation.id },
    orderBy: { sequence: 'desc' },
  });
  const message = await db.message.create({
    data: {
      tenantId: f.tenantId,
      conversationId: conversation.id,
      channelAccountId: f.channelAccountId,
      authorType: 'BOT',
      direction: 'OUTBOUND',
      type: 'TEXT',
      text,
      sequence: (latest?.sequence ?? 0) + 1,
      providerChatId: customerId,
      deliveryState: 'PENDING',
    },
  });
  const outbox = await db.outboxEvent.create({
    data: {
      tenantId: f.tenantId,
      type: 'telegram.send',
      aggregateType: 'message',
      aggregateId: message.id,
      idempotencyKey: `telegram.send:${message.id}`,
      payload: { messageId: message.id },
    },
  });
  return {
    message,
    event: {
      outboxId: outbox.id,
      tenantId: f.tenantId,
      type: outbox.type,
      payload: outbox.payload,
    } satisfies TelegramQueueEvent,
  };
}

describe('Messenger: inbound to agent reply to Graph send', () => {
  it('LIVE without a Telegram group: answers via the Page, never Telegram', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const { event } = await receive(f, 'IELTS kerak');
    await f.processor.process(event);
    await f.processor.process(event); // duplicate job: nothing left to answer

    const [reply] = await outbound(f);
    expect(await outbound(f)).toHaveLength(1);
    expect(reply).toMatchObject({
      authorType: 'BOT',
      deliveryState: 'PENDING',
      providerChatId: CUSTOMER_ID,
    });
    const queued = await sends(f);
    expect(queued).toHaveLength(1);
    await f.processor.process(queued[0]!);
    await f.processor.process(queued[0]!); // retried job: already SENT
    expect(f.calls).toHaveLength(1);
    const url = new URL(f.calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://graph.facebook.com/v27.0/${f.pageId}/messages`,
    );
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      recipient: { id: CUSTOMER_ID },
      messaging_type: 'RESPONSE',
      message: { text: reply!.text },
    });
    expect(f.telegram.sendMessage).not.toHaveBeenCalled();
    const [sent] = await outbound(f);
    expect(sent).toMatchObject({
      deliveryState: 'SENT',
      deliveryErrorCode: null,
    });
  });

  it('a duplicate webhook delivery of the same mid is stored once', async () => {
    const f = await fixture({ mode: 'SHADOW' });
    const { mid } = await receive(f, 'Salom');
    const again = normalizeFacebookWebhook(
      {
        object: 'page',
        entry: [
          {
            id: f.pageId,
            time: Date.now(),
            messaging: [
              {
                sender: { id: CUSTOMER_ID },
                recipient: { id: f.pageId },
                timestamp: Date.now(),
                message: { mid, text: 'Salom' },
              },
            ],
          },
        ],
      },
      new Date(),
    );
    if (!again.ok || again.events[0]?.kind !== 'text') throw new Error('text');
    expect(await f.intake.accept(again.events[0], 'facebook')).toBe(
      'duplicate',
    );
    expect(
      await db.inboundEvent.count({ where: { tenantId: f.tenantId } }),
    ).toBe(1);
  });

  it('a Page of another channel type never receives a Messenger delivery', async () => {
    const f = await fixture({ mode: 'LIVE' });
    // The same numeric id as an Instagram account is not a Messenger Page.
    await db.channelAccount.update({
      where: { id: f.channelAccountId },
      data: { channelType: 'instagram' },
    });
    const normalized = normalizeFacebookWebhook(
      {
        object: 'page',
        entry: [
          {
            id: f.pageId,
            time: Date.now(),
            messaging: [
              {
                sender: { id: CUSTOMER_ID },
                recipient: { id: f.pageId },
                timestamp: Date.now(),
                message: { mid: `mid.${randomUUID()}`, text: 'x' },
              },
            ],
          },
        ],
      },
      new Date(),
    );
    if (!normalized.ok || normalized.events[0]?.kind !== 'text')
      throw new Error('text');
    expect(await f.intake.accept(normalized.events[0], 'facebook')).toBe(
      'unavailable',
    );
  });
});

describe('Messenger send: window and credentials', () => {
  it('outside the 24-hour window nothing is sent', async () => {
    const f = await fixture({ mode: 'LIVE' });
    await receive(f, 'Salom');
    await db.conversation.updateMany({
      where: { tenantId: f.tenantId },
      data: { lastInboundAt: new Date(Date.now() - 25 * HOUR_MS) },
    });
    const { message, event } = await queueReply(f, 'Javob');
    await f.processor.process(event);
    expect(f.calls).toHaveLength(0);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({ deliveryErrorCode: 'facebook_window_closed' });
  });

  it('without a stored Page token nothing is sent', async () => {
    const f = await fixture({ mode: 'LIVE', storeToken: false });
    await receive(f, 'Salom');
    const { message, event } = await queueReply(f, 'Javob');
    await f.processor.process(event);
    expect(f.calls).toHaveLength(0);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryState: 'FAILED',
      deliveryErrorCode: 'facebook_not_configured',
    });
  });
});
