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
import { LlmError } from '../../core/llm/llm-provider.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../../core/llm/scripted-llm-provider.js';
import {
  PrismaClient,
  type InstagramComment,
} from '../../generated/prisma/client.js';
import { UZ_LATN } from '../../locales/locale-packs.js';
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
import {
  COMMENT_PUBLIC_REPLY_EVENT,
  InstagramCommentReplyService,
  PRIVATE_REPLY_WINDOW_MS,
} from './instagram-comment-reply.service.js';
import { InstagramGraphClient } from './instagram-graph.js';
import { normalizeInstagramWebhook } from './instagram-normalizer.js';
import { InstagramSender } from './instagram-sender.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

/**
 * ADR 043 end to end on the real database: a comment webhook -> intake (a
 * COMMENT message in the commenter's conversation) -> the agent pipeline ->
 * one private reply -> the public template reply. A fake Graph transport;
 * no network, no real Meta account or credential.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Instagram comment integration tests require agentcore_test');

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

const TOKEN = `test-${randomBytes(16).toString('hex')}`;
const COMMENTER_ID = '5550002';
/** Real Meta ids are 15-18 digits; fakes have the same shape. */
const digits = (): string => `1784${randomInt(10 ** 11, 10 ** 12 - 1)}`;

type Meta = (url: URL, init: RequestInit) => { status: number; body: unknown };
const metaOk: Meta = (url) =>
  url.pathname.endsWith('/replies')
    ? { status: 200, body: { id: digits() } }
    : {
        status: 200,
        body: {
          recipient_id: COMMENTER_ID,
          message_id: `aWdfZAG1${randomUUID()}`,
        },
      };

interface Fixture {
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly igUserId: string;
  readonly intake: InstagramWebhookService;
  readonly processor: TelegramProcessor;
  readonly calls: { url: URL; init: RequestInit }[];
}

async function fixture(options: {
  mode: 'OFF' | 'SHADOW' | 'LIVE';
  intent?: string;
  llmDown?: boolean;
  meta?: Meta;
  unified?: boolean;
}): Promise<Fixture> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `ig-comment-${suffix}`,
      name: 'Instagram comment fixture',
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
  await secrets.put(
    { tenantId: tenant.id, channelAccountId: account.id },
    options.unified === false
      ? 'instagram_access_token'
      : 'instagram_system_user_token',
    TOKEN,
  );
  const calls: { url: URL; init: RequestInit }[] = [];
  const meta = options.meta ?? metaOk;
  const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? 'GET') === 'GET')
      // User Profile lookups: refused, the contact stays unnamed.
      return new Response(JSON.stringify({ error: { code: 230 } }), {
        status: 400,
      });
    calls.push({ url, init: init ?? {} });
    const reply = meta(url, init ?? {});
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  const provider = new ScriptedLlmProvider((call): ScriptStep =>
    options.llmDown
      ? {
          kind: 'error',
          error: new LlmError('LLM_UNAVAILABLE', 'test outage', false),
        }
      : call.type === 'structured'
        ? extraction({ subject: 'IELTS' }, options.intent ?? 'search')
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
  const instagram = new InstagramSender(
    prisma,
    new InstagramGraphClient(request as unknown as typeof fetch),
    secrets,
  );
  const processor = new TelegramProcessor(
    prisma,
    { sendMessage: vi.fn() } as unknown as TelegramSender,
    new TelegramAgentPipeline(prisma, agent, cfg, PRODUCTION),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    instagram,
    undefined,
    undefined,
    new InstagramCommentReplyService(prisma, instagram),
  );
  return {
    tenantId: tenant.id,
    channelAccountId: account.id,
    igUserId,
    intake: new InstagramWebhookService(prisma),
    processor,
    calls,
  };
}

function commentWebhook(
  f: Fixture,
  commentId: string,
  text: string,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    object: 'instagram',
    entry: [
      {
        id: f.igUserId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: 'comments',
            value: {
              comment_id: commentId,
              text,
              from: { id: COMMENTER_ID, username: 'mijoz_test' },
              media: { id: digits(), media_product_type: 'FEED' },
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

async function receiveComment(
  f: Fixture,
  text: string,
  commentId = digits(),
): Promise<{ commentId: string; event: TelegramQueueEvent }> {
  const normalized = normalizeInstagramWebhook(
    commentWebhook(f, commentId, text),
    new Date(),
  );
  if (!normalized.ok || normalized.events[0]?.kind !== 'comment')
    throw new Error('expected one comment event');
  expect(await f.intake.acceptComment(normalized.events[0])).toBe('accepted');
  const outbox = await db.outboxEvent.findFirstOrThrow({
    where: { tenantId: f.tenantId, type: 'instagram.inbound' },
    orderBy: { createdAt: 'desc' },
  });
  return {
    commentId,
    event: {
      outboxId: outbox.id,
      tenantId: f.tenantId,
      type: outbox.type,
      payload: outbox.payload,
    },
  };
}

async function queued(f: Fixture, type: string): Promise<TelegramQueueEvent[]> {
  const rows = await db.outboxEvent.findMany({
    where: { tenantId: f.tenantId, type },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    outboxId: row.id,
    tenantId: row.tenantId,
    type: row.type,
    payload: row.payload,
  }));
}

async function commentRow(
  f: Fixture,
  commentId: string,
): Promise<InstagramComment> {
  return db.instagramComment.findFirstOrThrow({
    where: { tenantId: f.tenantId, commentId },
  });
}

describe('Instagram comments (ADR 043): intake', () => {
  it('stores the comment as a COMMENT message once, without opening the DM window', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const commentId = digits();
    const normalized = normalizeInstagramWebhook(
      commentWebhook(f, commentId, 'Narxi qancha?'),
      new Date(),
    );
    if (!normalized.ok || normalized.events[0]?.kind !== 'comment')
      throw new Error('expected a comment');
    expect(await f.intake.acceptComment(normalized.events[0])).toBe('accepted');
    expect(await f.intake.acceptComment(normalized.events[0])).toBe(
      'duplicate',
    );

    const messages = await db.message.findMany({
      where: { tenantId: f.tenantId },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'COMMENT',
      direction: 'INBOUND',
      text: 'Narxi qancha?',
      providerChatId: COMMENTER_ID,
    });
    const conversation = await db.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    expect(conversation.lastInboundAt).toBeNull();
    expect(await commentRow(f, commentId)).toMatchObject({
      status: 'RECEIVED',
      messageId: messages[0]!.id,
      conversationId: conversation.id,
      mediaProductType: 'FEED',
    });
    expect(await queued(f, 'instagram.inbound')).toHaveLength(1);
  });

  it('ignores a comment id that is not plain digits', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const normalized = normalizeInstagramWebhook(
      commentWebhook(f, '17x', 'Narxi?'),
      new Date(),
    );
    if (!normalized.ok || normalized.events[0]?.kind !== 'comment')
      throw new Error('expected a comment');
    expect(await f.intake.acceptComment(normalized.events[0])).toBe('ignored');
    expect(await db.message.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });
});

describe('Instagram comments (ADR 043): answers', () => {
  it('LIVE: a question gets one private reply, then the public template under the comment', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    await f.processor.process(event);

    const [send] = await queued(f, 'telegram.send');
    expect(send).toBeDefined();
    await f.processor.process(send!);
    await f.processor.process(send!); // retried job: nothing is sent again

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url.origin + f.calls[0]!.url.pathname).toBe(
      `https://graph.facebook.com/v27.0/${f.igUserId}/messages`,
    );
    const reply = await db.message.findFirstOrThrow({
      where: { tenantId: f.tenantId, direction: 'OUTBOUND' },
    });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      recipient: { comment_id: commentId },
      message: { text: reply.text },
    });
    expect(reply.deliveryState).toBe('SENT');
    expect(await commentRow(f, commentId)).toMatchObject({
      status: 'ANSWERED',
      privateReplyMessageId: reply.id,
    });

    const [publish] = await queued(f, COMMENT_PUBLIC_REPLY_EVENT);
    await f.processor.process(publish!);
    await f.processor.process(publish!); // retried job: posted once
    expect(f.calls).toHaveLength(2);
    const publicCall = f.calls[1]!;
    expect(publicCall.url.pathname).toBe(`/v27.0/${commentId}/replies`);
    expect(publicCall.url.searchParams.get('message')).toBe(
      UZ_LATN.templates.commentPublicReply,
    );
    // The public text carries no facts: no digits, no price.
    expect(UZ_LATN.templates.commentPublicReply).not.toMatch(/\d/u);
    const row = await commentRow(f, commentId);
    expect(row.publicReplyId).toMatch(/^[0-9]+$/u);
    expect(row.errorCode).toBeNull();
  });

  it('a comment that is not a question is skipped: no model reply, nothing sent, no lead', async () => {
    const f = await fixture({ mode: 'LIVE', intent: 'small_talk' });
    const { commentId, event } = await receiveComment(f, 'Zo‘r post 🔥');
    await f.processor.process(event);
    expect(await queued(f, 'telegram.send')).toHaveLength(0);
    expect(
      await db.message.count({
        where: { tenantId: f.tenantId, direction: 'OUTBOUND' },
      }),
    ).toBe(0);
    expect((await commentRow(f, commentId)).status).toBe('SKIPPED');
    expect(await db.lead.count({ where: { tenantId: f.tenantId } })).toBe(0);
    const [turn] = await db.agentTurn.findMany({
      where: { tenantId: f.tenantId },
    });
    expect(turn).toMatchObject({ status: 'COMMITTED', outcome: 'NO_REPLY' });
    expect(f.calls).toHaveLength(0);
  });

  it('SHADOW: the decision is recorded and nothing is sent', async () => {
    const f = await fixture({ mode: 'SHADOW' });
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    await f.processor.process(event);
    expect(await queued(f, 'telegram.send')).toHaveLength(0);
    expect((await commentRow(f, commentId)).status).toBe('RECEIVED');
    expect(f.calls).toHaveLength(0);
  });

  it('the one private reply is used once: a second bot message is not sent to the comment again', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    await f.processor.process(event);
    const [send] = await queued(f, 'telegram.send');
    await f.processor.process(send!);
    const conversation = await db.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    const second = await db.message.create({
      data: {
        tenantId: f.tenantId,
        conversationId: conversation.id,
        channelAccountId: f.channelAccountId,
        authorType: 'BOT',
        direction: 'OUTBOUND',
        type: 'TEXT',
        text: 'Yana bir xabar',
        sequence: 99,
        providerChatId: COMMENTER_ID,
        deliveryState: 'PENDING',
      },
    });
    await f.processor.process({
      outboxId: randomUUID(),
      tenantId: f.tenantId,
      type: 'telegram.send',
      payload: { messageId: second.id },
    });
    // No customer DM opened the 24-hour window: the direct message fails.
    expect(
      await db.message.findFirstOrThrow({ where: { id: second.id } }),
    ).toMatchObject({
      deliveryState: 'FAILED',
      deliveryErrorCode: 'instagram_window_closed',
    });
    expect(
      f.calls.filter((call) => call.url.pathname.endsWith('/messages')),
    ).toHaveLength(1);
    expect((await commentRow(f, commentId)).status).toBe('ANSWERED');
  });

  it('after 7 days the private reply is not attempted', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    await db.instagramComment.updateMany({
      where: { tenantId: f.tenantId, commentId },
      data: {
        commentedAt: new Date(Date.now() - PRIVATE_REPLY_WINDOW_MS - 60_000),
      },
    });
    await f.processor.process(event);
    const [send] = await queued(f, 'telegram.send');
    await f.processor.process(send!);
    expect(f.calls).toHaveLength(0);
    expect(await commentRow(f, commentId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'instagram_comment_window_closed',
    });
  });

  it('an account connected with a pasted token does not reply to comments', async () => {
    const f = await fixture({ mode: 'LIVE', unified: false });
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    await f.processor.process(event);
    const [send] = await queued(f, 'telegram.send');
    await f.processor.process(send!);
    expect(f.calls).toHaveLength(0);
    expect(await commentRow(f, commentId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'instagram_comment_unsupported',
    });
  });

  it('an ambiguous public reply is never posted again', async () => {
    let publicAttempts = 0;
    const f = await fixture({
      mode: 'LIVE',
      meta: (url, init) => {
        if (url.pathname.endsWith('/replies')) {
          publicAttempts += 1;
          return { status: 200, body: {} };
        }
        return metaOk(url, init);
      },
    });
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    await f.processor.process(event);
    const [send] = await queued(f, 'telegram.send');
    await f.processor.process(send!);
    const [publish] = await queued(f, COMMENT_PUBLIC_REPLY_EVENT);
    await f.processor.process(publish!);
    await f.processor.process(publish!);
    expect(publicAttempts).toBe(1);
    expect(await commentRow(f, commentId)).toMatchObject({
      publicReplyId: null,
      errorCode: 'public_reply_ambiguous',
    });
  });

  it('a refused private reply frees the comment: an operator answer is then sent as its private reply', async () => {
    let privateAttempts = 0;
    const f = await fixture({
      mode: 'LIVE',
      meta: (url, init) => {
        if (url.pathname.endsWith('/messages') && ++privateAttempts === 1)
          return {
            status: 400,
            body: { error: { code: 10, message: 'permission' } },
          };
        return metaOk(url, init);
      },
    });
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    await f.processor.process(event);
    const [send] = await queued(f, 'telegram.send');
    await f.processor.process(send!);
    expect(await commentRow(f, commentId)).toMatchObject({
      status: 'FAILED',
      privateReplyMessageId: null,
    });

    const conversation = await db.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    const operatorAnswer = await db.message.create({
      data: {
        tenantId: f.tenantId,
        conversationId: conversation.id,
        channelAccountId: f.channelAccountId,
        authorType: 'OPERATOR',
        direction: 'OUTBOUND',
        type: 'TEXT',
        text: 'Ha, IELTS kursimiz bor. Batafsil yozib beraman.',
        sequence: 50,
        providerChatId: COMMENTER_ID,
        deliveryState: 'PENDING',
      },
    });
    await f.processor.process({
      outboxId: randomUUID(),
      tenantId: f.tenantId,
      type: 'telegram.send',
      payload: { messageId: operatorAnswer.id },
    });
    expect(
      await db.message.findFirstOrThrow({ where: { id: operatorAnswer.id } }),
    ).toMatchObject({ deliveryState: 'SENT' });
    expect(JSON.parse(String(f.calls.at(-1)!.init.body))).toEqual({
      recipient: { comment_id: commentId },
      message: { text: operatorAnswer.text },
    });
    expect(await commentRow(f, commentId)).toMatchObject({
      status: 'ANSWERED',
      privateReplyMessageId: operatorAnswer.id,
    });
  });

  it('a direct message answered together with a comment goes out as a direct message', async () => {
    const f = await fixture({ mode: 'LIVE' });
    const dm = normalizeInstagramWebhook(
      {
        object: 'instagram',
        entry: [
          {
            id: f.igUserId,
            time: Date.now(),
            messaging: [
              {
                sender: { id: COMMENTER_ID },
                recipient: { id: f.igUserId },
                timestamp: Date.now(),
                message: { mid: `aWdfZAG1${randomUUID()}`, text: 'Salom' },
              },
            ],
          },
        ],
      },
      new Date(),
    );
    if (!dm.ok || dm.events[0]?.kind !== 'text')
      throw new Error('expected a text event');
    expect(await f.intake.accept(dm.events[0])).toBe('accepted');
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    await f.processor.process(event);
    const [send] = await queued(f, 'telegram.send');
    await f.processor.process(send!);
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0]!.init.body)).recipient).toEqual({
      id: COMMENTER_ID,
    });
    // The comment itself was not answered: its private reply is unused.
    expect(await commentRow(f, commentId)).toMatchObject({
      status: 'RECEIVED',
      privateReplyMessageId: null,
    });
  });

  it('a model outage leaves the comment FAILED for operators, with nothing sent and the language kept', async () => {
    const f = await fixture({ mode: 'LIVE', llmDown: true });
    const { commentId, event } = await receiveComment(f, 'IELTS kursi bormi?');
    const before = await db.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    await f.processor.process(event);
    expect(await queued(f, 'telegram.send')).toHaveLength(0);
    expect(await commentRow(f, commentId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'agent_unavailable',
    });
    const after = await db.conversation.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    expect({ language: after.language, script: after.script }).toEqual({
      language: before.language,
      script: before.script,
    });
    expect(await db.handover.count({ where: { tenantId: f.tenantId } })).toBe(
      0,
    );
  });
});
