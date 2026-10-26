import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HandoverService } from '../../handover/handover.service.js';
import { operatorStrings, refLine } from '../../handover/operator-text.js';
import { OperatorUpdateHandler } from '../../handover/operator-update.handler.js';
import { TelegramBotApi } from '../../handover/telegram-bot-api.js';
import { TelegramGroupNotifier } from '../../handover/telegram-group-notifier.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { PrismaChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { createKeyring, SecretCipher } from '../../secrets/secret-cipher.js';
import { TelegramCredentials } from './telegram-credentials.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

/**
 * The operator buttons as Telegram sends them: raw `callback_query` and reply
 * updates POSTed to the webhook route of one channel account, through the
 * webhook secret check, the update normalizer, the operator-group routing, the
 * operator handler, the handover commands (real database) and the account's
 * own bot (Bot API calls recorded by a fake transport). Nothing here talks to
 * the real Telegram.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Operator webhook tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const GROUP = '-100777';
const EN = operatorStrings('en');
let nextUpdate = 1_000;
const telegramId = (): string =>
  String(1_000_000_000 + Math.floor(Math.random() * 8_000_000_000));

interface BotCall {
  token: string;
  method: string;
  body: Record<string, unknown>;
}

interface Rig {
  controller: TelegramWebhookController;
  calls: BotCall[];
  accountId: string;
  tenantId: string;
  conversationId: string;
  handoverId: string;
  secret: string;
  token: string;
  operatorA: string;
  operatorB: string;
  viewer: string;
  deactivated: string;
  foreign: string;
}

async function rig(): Promise<Rig> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `opwh-${suffix}`,
      name: 'Operator webhook fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `opwh-${suffix}`,
      status: 'ACTIVE',
      operatorChatId: GROUP,
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Ali',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      state: 'WAITING_OPERATOR',
      language: 'en',
      script: 'Latn',
    },
  });
  await db.message.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      channelAccountId: account.id,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      text: 'I need a person',
      sequence: 1,
      providerChatId: `c-${suffix}`,
    },
  });
  const handover = await db.handover.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      reasonCode: 'CUSTOMER_REQUEST',
      summary: {},
      idempotencyKey: `h-${suffix}`,
      slaDueAt: new Date(Date.now() + 3_600_000),
      operatorChatId: GROUP,
      operatorMessageId: '101',
    },
  });
  const people = {
    operatorA: telegramId(),
    operatorB: telegramId(),
    viewer: telegramId(),
    deactivated: telegramId(),
    foreign: telegramId(),
  };
  const make = (
    telegramUserId: string,
    role: 'OPERATOR' | 'VIEWER',
    isActive = true,
  ): Promise<unknown> =>
    db.operator.create({
      data: {
        tenantId: tenant.id,
        displayName: role,
        role,
        telegramUserId,
        isActive,
      },
    });
  await make(people.operatorA, 'OPERATOR');
  await make(people.operatorB, 'OPERATOR');
  await make(people.viewer, 'VIEWER');
  await make(people.deactivated, 'OPERATOR', false);
  // An active operator, but of another workspace.
  const otherTenant = await db.tenant.create({
    data: {
      slug: `opwh-other-${suffix}`,
      name: 'Another workspace',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  await db.operator.create({
    data: {
      tenantId: otherTenant.id,
      displayName: 'foreign',
      role: 'OPERATOR',
      telegramUserId: people.foreign,
    },
  });

  // The bot token and webhook secret are the account's own (saved from the UI).
  const store = new PrismaChannelSecretStore(
    prisma,
    new SecretCipher(
      createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
    ),
  );
  const token = `${telegramId()}:AAH-opwh_token_${randomBytes(12).toString('hex')}`;
  const secret = randomBytes(24).toString('base64url');
  const owner = { tenantId: tenant.id, channelAccountId: account.id };
  await store.put(owner, 'bot_token', token);
  await store.put(owner, 'webhook_secret', secret);

  const calls: BotCall[] = [];
  let sent = 500;
  const fakeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const match = /\/bot([^/]+)\/(\w+)$/u.exec(String(input))!;
    calls.push({
      token: match[1],
      method: match[2],
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: ++sent } }),
      ),
    );
  }) as typeof fetch;
  const config = { get: () => undefined } as never;
  const credentials = new TelegramCredentials(prisma, config, store);
  const notifier = new TelegramGroupNotifier(
    new TelegramBotApi(config, fakeFetch, credentials),
  );
  const controller = new TelegramWebhookController(
    new TelegramWebhookService(prisma, config, credentials),
    new OperatorUpdateHandler(prisma, new HandoverService(prisma), notifier),
  );
  return {
    controller,
    calls,
    accountId: account.id,
    tenantId: tenant.id,
    conversationId: conversation.id,
    handoverId: handover.id,
    secret,
    token,
    ...people,
  };
}

const press = (
  user: string,
  data: string,
  chat = GROUP,
  callbackId = randomUUID(),
): Record<string, unknown> => ({
  update_id: ++nextUpdate,
  callback_query: {
    id: callbackId,
    from: { id: Number(user), is_bot: false, first_name: 'X' },
    message: { message_id: 101, chat: { id: Number(chat) } },
    data,
  },
});

const replyText = (
  user: string,
  text: string,
  handoverId: string,
): Record<string, unknown> => ({
  update_id: ++nextUpdate,
  message: {
    message_id: ++nextUpdate,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(GROUP) },
    from: { id: Number(user), is_bot: false, first_name: 'X' },
    text,
    reply_to_message: {
      message_id: 101,
      chat: { id: Number(GROUP) },
      text: `Handover card\n${refLine(handoverId)}`,
    },
  },
});

async function state(
  r: Rig,
): Promise<{ state: string; assigned: boolean; handover: string }> {
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: r.conversationId },
  });
  const handover = await db.handover.findUniqueOrThrow({
    where: { id: r.handoverId },
  });
  return {
    state: conversation.state,
    assigned: conversation.assignedOperatorId !== null,
    handover: handover.status,
  };
}

const acks = (r: Rig): string[] =>
  r.calls
    .filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => String(c.body.text));

describe('operator buttons through the webhook', () => {
  it("take over, reply and return to bot, answered by the account's own bot", async () => {
    const r = await rig();
    await r.controller.receive(
      r.accountId,
      r.secret,
      press(r.operatorA, `t:${r.handoverId}`),
    );
    expect(await state(r)).toMatchObject({
      state: 'OPERATOR_ACTIVE',
      assigned: true,
    });
    const afterTake = r.calls.map((c) => c.method);
    expect(afterTake).toContain('answerCallbackQuery');
    expect(afterTake).toContain('editMessageReplyMarkup');
    expect(acks(r)).toEqual([EN.done]);
    // The buttons now offer "return" and "close".
    const edit = r.calls.find((c) => c.method === 'editMessageReplyMarkup')!;
    expect(JSON.stringify(edit.body.reply_markup)).toContain(
      `r:${r.handoverId}`,
    );

    await r.controller.receive(
      r.accountId,
      r.secret,
      replyText(r.operatorA, 'Hello, I am a person', r.handoverId),
    );
    const outbound = await db.message.findMany({
      where: { conversationId: r.conversationId, direction: 'OUTBOUND' },
    });
    expect(outbound.map((m) => [m.authorType, m.text])).toEqual([
      ['OPERATOR', 'Hello, I am a person'],
    ]);
    expect(
      r.calls.some(
        (c) => c.method === 'sendMessage' && c.body.text === EN.replied,
      ),
    ).toBe(true);

    await r.controller.receive(
      r.accountId,
      r.secret,
      press(r.operatorA, `r:${r.handoverId}`),
    );
    expect(await state(r)).toMatchObject({
      state: 'BOT_ACTIVE',
      assigned: false,
      handover: 'RESOLVED',
    });
    // Every Bot API call used this account's token, and only that.
    expect(new Set(r.calls.map((c) => c.token))).toEqual(new Set([r.token]));
    const actions = (
      await db.auditEvent.findMany({
        where: { tenantId: r.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual([
      'operator.take_over',
      'operator.reply',
      'operator.return_to_bot',
    ]);
  });

  it('a redelivered callback changes nothing', async () => {
    const r = await rig();
    const body = press(r.operatorA, `t:${r.handoverId}`);
    await r.controller.receive(r.accountId, r.secret, body);
    const first = await state(r);
    await r.controller.receive(r.accountId, r.secret, body);
    expect(await state(r)).toEqual(first);
    expect(acks(r)).toEqual([EN.done, EN.duplicate]);
    expect(
      await db.auditEvent.count({
        where: { tenantId: r.tenantId, action: 'operator.take_over' },
      }),
    ).toBe(1);
  });
});

describe('who may press the buttons', () => {
  it('refuses everyone who is not an active operator of this workspace, on every button', async () => {
    const r = await rig();
    const refused: Array<[string, string]> = [
      ['unknown person', telegramId()],
      ['viewer (read-only role)', r.viewer],
      ['deactivated operator', r.deactivated],
      ["another workspace's operator", r.foreign],
    ];
    for (const [, user] of refused)
      for (const action of ['t', 'r', 'c'])
        await r.controller.receive(
          r.accountId,
          r.secret,
          press(user, `${action}:${r.handoverId}`),
        );
    expect(await state(r)).toEqual({
      state: 'WAITING_OPERATOR',
      assigned: false,
      handover: 'OPEN',
    });
    // Each press was answered with the refusal, none with "Done".
    expect(acks(r)).toHaveLength(refused.length * 3);
    expect(new Set(acks(r))).toEqual(new Set([EN.forbidden]));
    expect(await db.auditEvent.count({ where: { tenantId: r.tenantId } })).toBe(
      0,
    );
    expect(r.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(
      false,
    );
  });

  it('refuses their typed replies too: nothing reaches the customer', async () => {
    const r = await rig();
    for (const user of [telegramId(), r.viewer, r.deactivated, r.foreign])
      await r.controller.receive(
        r.accountId,
        r.secret,
        replyText(user, 'Hello from a stranger', r.handoverId),
      );
    expect(
      await db.message.count({
        where: { conversationId: r.conversationId, direction: 'OUTBOUND' },
      }),
    ).toBe(0);
    const notices = r.calls
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.body.text);
    expect(new Set(notices)).toEqual(new Set([EN.forbidden]));
    expect((await state(r)).state).toBe('WAITING_OPERATOR');
  });

  it('another active operator cannot return, close or reply on a conversation someone else holds', async () => {
    const r = await rig();
    await r.controller.receive(
      r.accountId,
      r.secret,
      press(r.operatorA, `t:${r.handoverId}`),
    );
    const held = await state(r);
    r.calls.length = 0;
    for (const action of ['r', 'c'])
      await r.controller.receive(
        r.accountId,
        r.secret,
        press(r.operatorB, `${action}:${r.handoverId}`),
      );
    await r.controller.receive(
      r.accountId,
      r.secret,
      replyText(r.operatorB, 'I am not the owner', r.handoverId),
    );
    expect(await state(r)).toEqual(held);
    expect(new Set(acks(r))).toEqual(new Set([EN.notAssigned]));
    expect(
      await db.message.count({
        where: { conversationId: r.conversationId, direction: 'OUTBOUND' },
      }),
    ).toBe(0);
    // A second take-over loses too.
    await r.controller.receive(
      r.accountId,
      r.secret,
      press(r.operatorB, `t:${r.handoverId}`),
    );
    expect(acks(r).at(-1)).toBe(EN.alreadyTaken);
    expect(await state(r)).toEqual(held);
  });

  it('ignores presses from any chat but the operator group, and unusable button data', async () => {
    const r = await rig();
    await r.controller.receive(
      r.accountId,
      r.secret,
      press(r.operatorA, `t:${r.handoverId}`, '-999'),
    );
    for (const data of ['x:garbage', `t:${randomUUID()}`, 't:not-a-uuid'])
      await r.controller.receive(
        r.accountId,
        r.secret,
        press(r.operatorA, data),
      );
    expect(await state(r)).toEqual({
      state: 'WAITING_OPERATOR',
      assigned: false,
      handover: 'OPEN',
    });
    expect(await db.auditEvent.count({ where: { tenantId: r.tenantId } })).toBe(
      0,
    );
  });
});

describe('the webhook secret guards the buttons', () => {
  it("a missing, wrong or another account's secret is refused before anything happens", async () => {
    const r = await rig();
    const other = await rig();
    for (const secret of [undefined, 'wrong', other.secret])
      await expect(
        r.controller.receive(
          r.accountId,
          secret,
          press(r.operatorA, `t:${r.handoverId}`),
        ),
      ).rejects.toMatchObject({ status: 401 });
    // An unknown account answers like an unconfigured server.
    await expect(
      r.controller.receive(
        randomUUID(),
        r.secret,
        press(r.operatorA, `t:${r.handoverId}`),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await state(r)).toEqual({
      state: 'WAITING_OPERATOR',
      assigned: false,
      handover: 'OPEN',
    });
    expect(r.calls).toHaveLength(0);
  });

  it('a disabled account no longer accepts button presses', async () => {
    const r = await rig();
    await db.channelAccount.update({
      where: { id: r.accountId },
      data: { status: 'DISABLED' },
    });
    await expect(
      r.controller.receive(
        r.accountId,
        r.secret,
        press(r.operatorA, `t:${r.handoverId}`),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect((await state(r)).state).toBe('WAITING_OPERATOR');
  });
});
