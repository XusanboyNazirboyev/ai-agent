import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AgentConversationService } from '../../agent/agent-conversation.service.js';
import type { AgentModePolicy } from '../../agent/agent-mode.js';
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
import { InstagramApiError, InstagramGraphClient } from './instagram-graph.js';
import { normalizeInstagramWebhook } from './instagram-normalizer.js';
import { InstagramSender } from './instagram-sender.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

/**
 * Instagram DM end to end on the real database: durable webhook intake ->
 * `instagram.inbound` -> the shared agent pipeline (modes, idempotent commit)
 * -> the channel send queue -> the Instagram sender with the messaging-window
 * gate -> a fake Meta Graph transport. No network, no real Meta credentials.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Instagram flow integration tests require agentcore_test');

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
/** Instagram-scoped id of the (fictional) customer. */
const CUSTOMER_ID = '5550001';
/** Meta error codes (graph-api/guides/error-handling; 613: Send API). */
const META_RATE_LIMITED = 613;
const META_TOKEN_EXPIRED = 190;
const META_PERMISSION_MISSING = 10;
const META_INVALID_PARAMETER = 100;
const META_TEMPORARY = 2;
const HOUR_MS = 60 * 60 * 1000;
const digits = (): string => `1784${randomInt(10 ** 9, 10 ** 10 - 1)}`;

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
  readonly igUserId: string;
  readonly intake: InstagramWebhookService;
  readonly processor: TelegramProcessor;
  readonly instagram: InstagramSender;
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
      slug: `ig-flow-${suffix}`,
      name: 'Instagram flow fixture',
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
  const igUserId = digits();
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'instagram',
      externalAccountId: igUserId,
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
      'instagram_access_token',
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
  const instagram = new InstagramSender(
    prisma,
    new InstagramGraphClient(request as unknown as typeof fetch),
    secrets,
  );
  const processor = new TelegramProcessor(
    prisma,
    telegram as unknown as TelegramSender,
    new TelegramAgentPipeline(prisma, agent, cfg, DEV),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    instagram,
  );
  return {
    tenantId: tenant.id,
    channelAccountId: account.id,
    igUserId,
    intake: new InstagramWebhookService(prisma),
    processor,
    instagram,
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
  const normalized = normalizeInstagramWebhook(
    {
      object: 'instagram',
      entry: [
        {
          id: f.igUserId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: customerId },
              recipient: { id: f.igUserId },
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
  expect(await f.intake.accept(normalized.events[0])).toBe('accepted');
  const outbox = await db.outboxEvent.findFirstOrThrow({
    where: {
      tenantId: f.tenantId,
      type: 'instagram.inbound',
      idempotencyKey: `instagram.inbound:${f.channelAccountId}:${mid}`,
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

describe('Instagram DM: inbound to agent reply to Graph send', () => {
  it('LIVE: answers through the agent pipeline and sends once via Instagram, never Telegram', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const { event } = await receive(f, 'IELTS kerak');
    await f.processor.process(event);
    // Duplicate job delivery: nothing left to answer.
    await f.processor.process(event);

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
    expect(f.calls[0]?.url).toBe(
      `https://graph.instagram.com/v26.0/${f.igUserId}/messages`,
    );
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      recipient: { id: CUSTOMER_ID },
      message: { text: reply!.text },
    });
    expect(f.telegram.sendMessage).not.toHaveBeenCalled();
    const [sent] = await outbound(f);
    expect(sent).toMatchObject({
      deliveryState: 'SENT',
      deliveryErrorCode: null,
    });
    expect(sent?.providerMessageId).toMatch(/^mid\./u);
    const [turn] = await db.agentTurn.findMany({
      where: { tenantId: f.tenantId },
    });
    expect(turn).toMatchObject({
      status: 'COMMITTED',
      replyMessageId: reply!.id,
    });
  });

  it('a duplicate webhook delivery of the same mid is stored once', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const { mid } = await receive(f, 'salom');
    const again = normalizeInstagramWebhook(
      {
        object: 'instagram',
        entry: [
          {
            id: f.igUserId,
            messaging: [
              {
                sender: { id: CUSTOMER_ID },
                recipient: { id: f.igUserId },
                message: { mid, text: 'salom' },
              },
            ],
          },
        ],
      },
      new Date(),
    );
    if (!again.ok || again.events[0]?.kind !== 'text') throw new Error('text');
    expect(await f.intake.accept(again.events[0])).toBe('duplicate');
    expect(
      await db.inboundEvent.count({ where: { tenantId: f.tenantId } }),
    ).toBe(1);
  });

  it('OFF: no echo, no model call, nothing sent; the event is closed', async () => {
    const f = await fixture({ mode: 'OFF' });
    const { event } = await receive(f, 'salom');
    await f.processor.process(event);
    expect(await outbound(f)).toHaveLength(0);
    expect(f.provider.calls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect(
      await db.inboundEvent.findFirstOrThrow({
        where: { tenantId: f.tenantId },
      }),
    ).toMatchObject({ status: 'PROCESSED' });
  });

  it('SHADOW: the draft is recorded and nothing is sent', async () => {
    const f = await fixture({ mode: 'SHADOW' });
    const { event } = await receive(f, 'IELTS kerak');
    await f.processor.process(event);
    expect(await outbound(f)).toHaveLength(0);
    expect(await sends(f)).toHaveLength(0);
    expect(
      await db.agentTurn.count({
        where: { tenantId: f.tenantId, status: 'COMMITTED', mode: 'SHADOW' },
      }),
    ).toBe(1);
    expect(f.calls).toHaveLength(0);
  });
});

describe('Instagram DM: inbound payloads that must not reach the agent', () => {
  it('ignores empty, whitespace and missing text, and refuses a message without a sender', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const item = (
      message: Record<string, unknown>,
      sender = true,
    ): Record<string, unknown> => ({
      ...(sender ? { sender: { id: CUSTOMER_ID } } : {}),
      recipient: { id: f.igUserId },
      message: { mid: `mid.edge.${randomUUID()}`, ...message },
    });
    expect(
      normalizeInstagramWebhook(
        {
          object: 'instagram',
          entry: [
            {
              id: f.igUserId,
              messaging: [item({ text: '' }), item({ text: '   ' }), item({})],
            },
          ],
        },
        new Date(),
      ),
    ).toEqual({
      ok: true,
      events: [
        { kind: 'ignored', reason: 'no_text' },
        { kind: 'ignored', reason: 'no_text' },
        { kind: 'ignored', reason: 'no_text' },
      ],
    });
    expect(
      normalizeInstagramWebhook(
        {
          object: 'instagram',
          entry: [{ id: f.igUserId, messaging: [item({ text: 'hi' }, false)] }],
        },
        new Date(),
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(
      await db.inboundEvent.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
  });
});

describe('Instagram send: window, errors and retry safety', () => {
  it.each([
    ['23h59m: inside the window, sent', 24 * HOUR_MS - 60_000, 'SENT', null, 1],
    [
      '24h01m: outside the window, refused before Meta',
      24 * HOUR_MS + 60_000,
      'FAILED',
      'instagram_window_closed',
      0,
    ],
  ] as const)(
    'bot reply after the last customer message, %s',
    async (_label, ageMs, state, code, metaCalls) => {
      const f = await fixture({ mode: 'OFF' });
      await receive(f, 'salom');
      await db.conversation.updateMany({
        where: { tenantId: f.tenantId },
        data: { lastInboundAt: new Date(Date.now() - ageMs) },
      });
      const { message, event } = await queueReply(f, 'Javob');
      await f.processor.process(event);
      expect(f.calls).toHaveLength(metaCalls);
      expect(
        await db.message.findUniqueOrThrow({ where: { id: message.id } }),
      ).toMatchObject({ deliveryState: state, deliveryErrorCode: code });
    },
  );

  it('a rate limit leaves the message PENDING and rethrows for a queue retry; a later success sends once', async () => {
    let first = true;
    const f = await fixture({
      mode: 'OFF',
      meta: (...args) => {
        if (!first) return sentOk(...args);
        first = false;
        return {
          status: 400,
          body: { error: { code: META_RATE_LIMITED, message: 'x' } },
        };
      },
    });
    await receive(f, 'salom');
    const { message, event } = await queueReply(f, 'Javob');
    await expect(f.processor.process(event)).rejects.toBeInstanceOf(
      InstagramApiError,
    );
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryState: 'PENDING',
      deliveryErrorCode: 'instagram_api_rate_limited',
    });
    await f.processor.process(event);
    expect(f.calls).toHaveLength(2);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({ deliveryState: 'SENT', deliveryErrorCode: null });
  });

  it.each([
    [META_TOKEN_EXPIRED, 'instagram_api_token'],
    [META_PERMISSION_MISSING, 'instagram_api_permission'],
    [META_INVALID_PARAMETER, 'instagram_api_rejected'],
  ])(
    'Meta error %i fails the message without a retry (%s)',
    async (code, expected) => {
      const f = await fixture({
        mode: 'OFF',
        meta: () => ({ status: 400, body: { error: { code } } }),
      });
      await receive(f, 'salom');
      const { message, event } = await queueReply(f, 'Javob');
      await f.processor.process(event);
      await f.processor.process(event);
      expect(f.calls).toHaveLength(1);
      expect(
        await db.message.findUniqueOrThrow({ where: { id: message.id } }),
      ).toMatchObject({ deliveryState: 'FAILED', deliveryErrorCode: expected });
    },
  );

  it('an ambiguous outcome stays UNKNOWN and is never resent', async () => {
    const f = await fixture({
      mode: 'OFF',
      meta: () => ({ status: 200, body: { recipient_id: CUSTOMER_ID } }),
    });
    await receive(f, 'salom');
    const { message, event } = await queueReply(f, 'Javob');
    await f.processor.process(event);
    await f.processor.process(event);
    expect(f.calls).toHaveLength(1);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryState: 'UNKNOWN',
      deliveryErrorCode: 'instagram_ambiguous_outcome',
    });
  });

  it('splits a long reply into 1,000-byte parts; a failure after the first part is never resent', async () => {
    let n = 0;
    const f = await fixture({
      mode: 'OFF',
      meta: (...args) =>
        ++n === 1
          ? sentOk(...args)
          : { status: 500, body: { error: { code: META_TEMPORARY } } },
    });
    await receive(f, 'salom');
    const long = Array.from({ length: 300 }, () => 'salom').join(' '); // 1,799 bytes
    const { message, event } = await queueReply(f, long);
    await f.processor.process(event);
    await f.processor.process(event);
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls)
      expect(
        Buffer.byteLength(
          (JSON.parse(String(call.init.body)) as { message: { text: string } })
            .message.text,
        ),
      ).toBeLessThanOrEqual(1_000);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryState: 'FAILED',
      deliveryErrorCode: 'instagram_partial_send',
    });
  });

  it('without a stored access token nothing is sent', async () => {
    const f = await fixture({ mode: 'OFF', storeToken: false });
    await receive(f, 'salom');
    const { message, event } = await queueReply(f, 'Javob');
    await f.processor.process(event);
    expect(f.calls).toHaveLength(0);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryState: 'FAILED',
      deliveryErrorCode: 'instagram_not_configured',
    });
  });

  it("never sends with another tenant's account, even given its id", async () => {
    const a = await fixture({ mode: 'OFF' });
    const b = await fixture({ mode: 'OFF' });
    await expect(
      b.instagram.sendText(b.tenantId, a.channelAccountId, CUSTOMER_ID, 'x'),
    ).rejects.toMatchObject({ name: 'InstagramNotConfiguredError' });
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });
});
