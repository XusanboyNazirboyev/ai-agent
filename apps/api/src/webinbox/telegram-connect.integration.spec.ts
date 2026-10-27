import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { TelegramCredentials } from '../channels/telegram/telegram-credentials.js';
import { TelegramManagement } from '../channels/telegram/telegram-management.js';
import { TelegramWebhookService } from '../channels/telegram/telegram-webhook.service.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { PrismaChannelSecretStore } from '../secrets/channel-secret-store.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import { ChannelsController } from './channels.controller.js';
import { TelegramConnectController } from './telegram-connect.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Telegram connect tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

// Bot ids are globally unique, so every run uses its own range.
const RUN = Math.floor(Math.random() * 1e9) * 10;
const TOKEN = (n: number): string =>
  `${n}:AAH-test_token_value_${'x'.repeat(16)}`;

interface Call {
  method: string;
  token: string;
  params: Record<string, unknown>;
}

/** A fake api.telegram.org: bots are the tokens in `valid`. */
interface FakeTelegram {
  request: ReturnType<typeof vi.fn>;
  calls: Call[];
  webhooks: Map<string, string>;
  failNextWebhook: () => void;
  /** Makes every later call of a method fail: a network error that names the token, or an HTTP 500. */
  fail: (method: string, kind: 'network' | 'rejected' | null) => void;
}

function fakeTelegram(
  valid: Map<string, { id: number; username: string }>,
): FakeTelegram {
  const calls: Call[] = [];
  let failWebhook = false;
  const webhooks = new Map<string, string>();
  const failing = new Map<string, 'network' | 'rejected'>();
  const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const match = /\/bot([^/]+)\/(\w+)$/u.exec(String(input))!;
    const [, token, method] = match;
    const params = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    calls.push({ method, token, params });
    const failure = failing.get(method);
    if (failure === 'network')
      // A real network error can name the URL, and the URL carries the token.
      return Promise.reject(
        new Error(`connect ECONNREFUSED ${String(input)} token=${token}`),
      );
    if (failure === 'rejected')
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 500 }),
      );
    const bot = valid.get(token);
    const reply = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (!bot) return reply(401, { ok: false, error_code: 401 });
    if (method === 'getMe')
      return reply(200, {
        ok: true,
        result: {
          id: bot.id,
          is_bot: true,
          first_name: 'Bot',
          username: bot.username,
        },
      });
    if (method === 'setWebhook') {
      if (failWebhook) return reply(400, { ok: false, error_code: 400 });
      webhooks.set(token, String(params.url));
      return reply(200, { ok: true, result: true });
    }
    if (method === 'deleteWebhook') {
      webhooks.delete(token);
      return reply(200, { ok: true, result: true });
    }
    if (method === 'getWebhookInfo')
      return reply(200, {
        ok: true,
        result: {
          url: webhooks.get(token) ?? '',
          pending_update_count: 3,
          last_error_message: 'Connection timed out',
          last_error_date: 1_700_000_000,
        },
      });
    return reply(404, { ok: false });
  });
  return {
    request,
    calls,
    webhooks,
    failNextWebhook: (): void => {
      failWebhook = true;
    },
    fail: (method, kind): void => {
      if (kind) failing.set(method, kind);
      else failing.delete(method);
    },
  };
}

async function tenant(
  role: 'ADMIN' | 'OPERATOR' = 'ADMIN',
): Promise<{ tenantId: string; request: never }> {
  const suffix = randomUUID();
  const created = await db.tenant.create({
    data: {
      slug: `tg-${suffix}`,
      name: 'Connect fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const operator = await db.operator.create({
    data: { tenantId: created.id, displayName: 'Admin', role },
  });
  return {
    tenantId: created.id,
    request: {
      principal: {
        tenantId: created.id,
        operatorId: operator.id,
        role,
        sessionId: randomUUID(),
      },
    } as never,
  };
}

const SETTINGS: Record<string, unknown> = {
  NODE_ENV: 'development',
  LLM_PROVIDER: 'mock',
  LLM_TRUSTED_PROVIDERS: ['mock'],
  LLM_ALLOW_REAL_CUSTOMER_DATA: false,
  PUBLIC_BASE_URL: 'https://bot.example.test/',
};
const configWith = (overrides: Record<string, unknown> = {}): never =>
  ({ get: (key: string) => ({ ...SETTINGS, ...overrides })[key] }) as never;

interface Setup {
  bots: Map<string, { id: number; username: string }>;
  telegram: FakeTelegram;
  store: PrismaChannelSecretStore;
  controller: TelegramConnectController;
  config: never;
}

function setup(
  options: { withKey?: boolean; config?: Record<string, unknown> } = {},
): Setup {
  const bots = new Map<string, { id: number; username: string }>();
  const telegram = fakeTelegram(bots);
  const store = new PrismaChannelSecretStore(
    prisma,
    options.withKey === false
      ? undefined
      : new SecretCipher(
          createKeyring({
            SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
          }),
        ),
  );
  const config = configWith(options.config);
  const controller = new TelegramConnectController(
    prisma,
    config,
    store,
    new TelegramManagement(telegram.request as never),
  );
  return { bots, telegram, store, controller, config };
}

describe('connecting a Telegram bot from the web', () => {
  it('validates the token, stores it encrypted, starts DISABLED and never returns a secret', async () => {
    const { bots, telegram, controller, store } = setup();
    const t = await tenant();
    await expect(
      controller.connect(t.request, { botToken: 'not a token' }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_TOKEN' } });
    expect(telegram.calls).toHaveLength(0);
    await expect(
      controller.connect(t.request, { botToken: TOKEN(RUN + 111) }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_TOKEN' } });

    bots.set(TOKEN(RUN + 222), { id: RUN + 222, username: 'shop_bot' });
    const summary = await controller.connect(t.request, {
      botToken: TOKEN(RUN + 222),
    });
    expect(summary).toMatchObject({
      channelType: 'telegram',
      displayName: '@shop_bot',
      status: 'DISABLED',
      agentMode: 'OFF',
      credentialSource: 'ui',
    });
    expect(JSON.stringify(summary)).not.toContain('AAH-test_token');
    const owner = { tenantId: t.tenantId, channelAccountId: summary.id };
    expect(await store.get(owner, 'bot_token')).toBe(TOKEN(RUN + 222));
    expect(
      (await store.get(owner, 'webhook_secret'))!.length,
    ).toBeGreaterThanOrEqual(32);
    const rows = await db.channelSecret.findMany({
      where: { tenantId: t.tenantId },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(Buffer.from(row.ciphertext).toString('latin1')).not.toContain(
        'AAH-test',
      );
    const audit = await db.auditEvent.findMany({
      where: { tenantId: t.tenantId },
    });
    expect(audit.map((a) => a.action)).toEqual(['channel.telegram_connected']);
    expect(JSON.stringify(audit)).not.toContain('AAH-test');
  });

  it('refuses a bot of another tenant, reconnects its own keeping the webhook secret', async () => {
    const { bots, controller, store } = setup();
    const a = await tenant();
    const b = await tenant();
    bots.set(TOKEN(RUN + 333), { id: RUN + 333, username: 'one' });
    const first = await controller.connect(a.request, {
      botToken: TOKEN(RUN + 333),
    });
    await expect(
      controller.connect(b.request, { botToken: TOKEN(RUN + 333) }),
    ).rejects.toMatchObject({ response: { code: 'ALREADY_CONNECTED' } });
    const owner = { tenantId: a.tenantId, channelAccountId: first.id };
    const secret = await store.get(owner, 'webhook_secret');
    bots.delete(TOKEN(RUN + 333));
    bots.set(TOKEN(RUN + 334), { id: RUN + 333, username: 'one_renamed' });
    const again = await controller.connect(a.request, {
      botToken: TOKEN(RUN + 334),
    });
    expect(again.id).toBe(first.id);
    expect(again.displayName).toBe('@one_renamed');
    expect(await store.get(owner, 'bot_token')).toBe(TOKEN(RUN + 334));
    expect(await store.get(owner, 'webhook_secret')).toBe(secret);
  });

  it('enable registers the webhook with the stored secret; the webhook route then accepts exactly that secret', async () => {
    const { bots, telegram, controller, store } = setup();
    const t = await tenant();
    bots.set(TOKEN(RUN + 444), { id: RUN + 444, username: 'live_bot' });
    const { id } = await controller.connect(t.request, {
      botToken: TOKEN(RUN + 444),
    });
    const noBase = setup({ config: { PUBLIC_BASE_URL: undefined } });
    await expect(
      new TelegramConnectController(
        prisma,
        noBase.config,
        store,
        new TelegramManagement(telegram.request as never),
      ).enable(t.request, id),
    ).rejects.toMatchObject({
      response: { code: 'PUBLIC_URL_NOT_CONFIGURED' },
    });

    telegram.failNextWebhook();
    await expect(controller.enable(t.request, id)).rejects.toMatchObject({
      response: { code: 'TELEGRAM_REJECTED' },
    });
    expect(
      (await db.channelAccount.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('DISABLED');
  });

  it('enable → webhook secret check → test checklist → disable → disconnect', async () => {
    const { bots, telegram, controller, store, config } = setup();
    const t = await tenant();
    bots.set(TOKEN(RUN + 555), { id: RUN + 555, username: 'flow_bot' });
    const { id } = await controller.connect(t.request, {
      botToken: TOKEN(RUN + 555),
    });
    const enabled = await controller.enable(t.request, id);
    expect(enabled.status).toBe('ACTIVE');
    const set = telegram.calls.find((c) => c.method === 'setWebhook')!;
    expect(set.params.url).toBe(
      `https://bot.example.test/webhooks/telegram/${id}`,
    );
    expect(set.params.allowed_updates).toEqual(['message', 'callback_query']);
    const owner = { tenantId: t.tenantId, channelAccountId: id };
    const secret = (await store.get(owner, 'webhook_secret'))!;
    expect(set.params.secret_token).toBe(secret);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{1,256}$/u);

    const webhook = new TelegramWebhookService(
      prisma,
      config,
      new TelegramCredentials(prisma, config, store),
    );
    await expect(
      webhook.assertWebhookSecret(id, secret),
    ).resolves.toBeUndefined();
    await expect(webhook.assertWebhookSecret(id, 'wrong')).rejects.toThrow(
      'Invalid',
    );

    const result = await controller.test(t.request, id);
    expect(result).toMatchObject({
      tokenValid: true,
      botUsername: 'flow_bot',
      status: 'ACTIVE',
      webhook: {
        registered: true,
        matchesExpected: true,
        pendingUpdates: 3,
        lastError: 'Connection timed out',
      },
    });

    await db.channelAccount.update({
      where: { id },
      data: { agentMode: 'SHADOW' },
    });
    const disabled = await controller.disable(t.request, id);
    expect(disabled).toMatchObject({ status: 'DISABLED', agentMode: 'OFF' });
    expect(telegram.webhooks.size).toBe(0);

    await controller.disconnect(t.request, id);
    expect(await store.exists(owner, 'bot_token')).toBe(false);
    expect(await db.channelAccount.count({ where: { id } })).toBe(1);
    await expect(webhook.assertWebhookSecret(id, secret)).rejects.toThrow(
      'not configured',
    );
    const actions = (
      await db.auditEvent.findMany({
        where: { tenantId: t.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual([
      'channel.telegram_connected',
      'channel.telegram_enabled',
      'channel.telegram_disabled',
      'channel.telegram_disconnected',
    ]);
  });

  it('operator group id, roles, tenant scope, missing key and rate limit', async () => {
    const { bots, controller } = setup();
    const t = await tenant();
    const other = await tenant();
    const op = await tenant('OPERATOR');
    bots.set(TOKEN(RUN + 666), { id: RUN + 666, username: 'g_bot' });
    const { id } = await controller.connect(t.request, {
      botToken: TOKEN(RUN + 666),
    });
    const set = await controller.operatorGroup(t.request, id, {
      chatId: '-1001234567890',
    });
    expect(set.operatorGroupConfigured).toBe(true);
    for (const bad of [{ chatId: 'abc' }, { chatId: '1; drop' }, {}])
      await expect(
        controller.operatorGroup(t.request, id, bad),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_CHAT_ID' },
      });
    expect(
      (await controller.operatorGroup(t.request, id, { chatId: null }))
        .operatorGroupConfigured,
    ).toBe(false);
    await expect(controller.disable(other.request, id)).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
    await expect(controller.disable(op.request, id)).rejects.toMatchObject({
      response: { code: 'FORBIDDEN' },
    });
    await expect(
      setup({ withKey: false }).controller.connect(t.request, {
        botToken: TOKEN(RUN + 666),
      }),
    ).rejects.toMatchObject({ response: { code: 'SECRETS_NOT_CONFIGURED' } });
    // The eleventh call within a minute is refused.
    const limited = setup();
    const t2 = await tenant();
    for (let i = 0; i < 10; i += 1)
      await limited.controller
        .connect(t2.request, { botToken: 'bad' })
        .catch(() => undefined);
    await expect(
      limited.controller.connect(t2.request, { botToken: 'bad' }),
    ).rejects.toMatchObject({ response: { code: 'RATE_LIMITED' } });
  });

  it('the channels list shows the saved credentials as "ui" without any value', async () => {
    const { bots, controller, config, store } = setup();
    const t = await tenant();
    bots.set(TOKEN(RUN + 777), { id: RUN + 777, username: 'list_bot' });
    await controller.connect(t.request, { botToken: TOKEN(RUN + 777) });
    const list = await new ChannelsController(prisma, config, store).list(
      t.request,
    );
    expect(list.capabilities).toEqual({
      secretsConfigured: true,
      publicUrlConfigured: true,
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      webhookUrl: `https://bot.example.test/webhooks/telegram/${list.items[0].id}`,
      displayName: '@list_bot',
      credentialSource: 'ui',
      credentialsConfigured: true,
    });
    expect(JSON.stringify(list)).not.toContain('AAH-test');
  });

  it('tenant B cannot enable, test, disconnect or change the operator group of tenant A (DEF-009)', async () => {
    const { bots, telegram, controller, store } = setup();
    const a = await tenant();
    const b = await tenant();
    bots.set(TOKEN(RUN + 801), { id: RUN + 801, username: 'a_bot' });
    const { id } = await controller.connect(a.request, {
      botToken: TOKEN(RUN + 801),
    });
    await controller.operatorGroup(a.request, id, { chatId: '-100555' });
    await controller.enable(a.request, id);
    const callsBefore = telegram.calls.length;

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['enable', (): Promise<unknown> => controller.enable(b.request, id)],
      ['test', (): Promise<unknown> => controller.test(b.request, id)],
      [
        'disconnect',
        (): Promise<unknown> => controller.disconnect(b.request, id),
      ],
      [
        'operator-group',
        (): Promise<unknown> =>
          controller.operatorGroup(b.request, id, { chatId: '-100999' }),
      ],
    ];
    for (const [name, attempt] of attempts)
      await expect(attempt(), name).rejects.toMatchObject({
        response: { code: 'NOT_FOUND' },
      });

    // Nothing reached Telegram and nothing of A's changed.
    expect(telegram.calls).toHaveLength(callsBefore);
    const row = await db.channelAccount.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'ACTIVE', operatorChatId: '-100555' });
    const owner = { tenantId: a.tenantId, channelAccountId: id };
    expect(await store.exists(owner, 'bot_token')).toBe(true);
    expect(await store.exists(owner, 'webhook_secret')).toBe(true);
    expect(telegram.webhooks.size).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { tenantId: b.tenantId, entityId: id },
      }),
    ).toBe(0);
  });

  it('the bot token stays out of log lines, responses and error messages when Telegram fails (DEF-010)', async () => {
    const logged: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation((...args) => {
          logged.push(args.map((a) => String(a)).join(' '));
        }),
    );
    try {
      const { bots, telegram, controller } = setup();
      const t = await tenant();
      bots.set(TOKEN(RUN + 811), { id: RUN + 811, username: 'leak_bot' });
      const seen: unknown[] = [];
      const run = async (attempt: () => Promise<unknown>): Promise<void> => {
        try {
          seen.push(await attempt());
        } catch (error) {
          seen.push(error);
        }
      };

      telegram.fail('getMe', 'network');
      await run(() =>
        controller.connect(t.request, { botToken: TOKEN(RUN + 811) }),
      );
      telegram.fail('getMe', null);
      const { id } = await controller.connect(t.request, {
        botToken: TOKEN(RUN + 811),
      });
      telegram.fail('setWebhook', 'network');
      await run(() => controller.enable(t.request, id));
      telegram.fail('setWebhook', 'rejected');
      await run(() => controller.enable(t.request, id));
      telegram.fail('setWebhook', null);
      telegram.fail('getMe', 'network');
      await run(() => controller.test(t.request, id));
      telegram.fail('getMe', null);
      telegram.fail('deleteWebhook', 'network');
      await run(() => controller.disable(t.request, id));
      await run(() => controller.disconnect(t.request, id));

      // The checks above must have exercised real failures and real log lines.
      expect(seen.filter((x) => x instanceof Error).length).toBeGreaterThan(3);
      expect(logged.some((l) => l.includes('telegram.'))).toBe(true);
      const everything = [
        ...logged,
        ...seen.map((x) =>
          x instanceof Error
            ? `${x.message}\n${x.stack ?? ''}\n${JSON.stringify(
                (x as { getResponse?: () => unknown }).getResponse?.() ?? null,
              )}`
            : JSON.stringify(x),
        ),
      ].join('\n');
      expect(everything).not.toContain('AAH-test_token');
      expect(everything).not.toContain(String(RUN + 811));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('disconnect of an ACTIVE account removes the webhook and the secrets in one call (DEF-011)', async () => {
    const { bots, telegram, controller, store } = setup();
    const t = await tenant();
    bots.set(TOKEN(RUN + 821), { id: RUN + 821, username: 'active_bot' });
    const { id } = await controller.connect(t.request, {
      botToken: TOKEN(RUN + 821),
    });
    await controller.enable(t.request, id);
    await db.channelAccount.update({
      where: { id },
      data: { agentMode: 'SHADOW' },
    });
    expect(telegram.webhooks.size).toBe(1);

    await controller.disconnect(t.request, id);

    expect(telegram.webhooks.size).toBe(0);
    expect(telegram.calls.some((c) => c.method === 'deleteWebhook')).toBe(true);
    const owner = { tenantId: t.tenantId, channelAccountId: id };
    expect(await store.exists(owner, 'bot_token')).toBe(false);
    expect(await store.exists(owner, 'webhook_secret')).toBe(false);
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: 'DISABLED', agentMode: 'OFF' });
  });

  it('keeps the secrets and says so when Telegram cannot remove the webhook; a retry finishes it (DEF-011)', async () => {
    const { bots, telegram, controller, store } = setup();
    const t = await tenant();
    bots.set(TOKEN(RUN + 831), { id: RUN + 831, username: 'retry_bot' });
    const { id } = await controller.connect(t.request, {
      botToken: TOKEN(RUN + 831),
    });
    await controller.enable(t.request, id);
    await db.channelAccount.update({
      where: { id },
      data: { agentMode: 'SHADOW' },
    });
    const owner = { tenantId: t.tenantId, channelAccountId: id };

    for (const kind of ['network', 'rejected'] as const) {
      telegram.fail('deleteWebhook', kind);
      await expect(
        controller.disconnect(t.request, id),
        kind,
      ).rejects.toMatchObject({
        response: { code: 'WEBHOOK_NOT_REMOVED' },
        status: 502,
      });
      // Recoverable: still connected (secrets kept), switched off, webhook still registered.
      expect(await store.exists(owner, 'bot_token')).toBe(true);
      expect(await store.exists(owner, 'webhook_secret')).toBe(true);
      expect(
        await db.channelAccount.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'DISABLED', agentMode: 'OFF' });
      expect(telegram.webhooks.size).toBe(1);
    }
    const pending = await db.auditEvent.findMany({
      where: {
        tenantId: t.tenantId,
        action: 'channel.telegram_disconnect_pending',
      },
    });
    expect(pending).toHaveLength(2);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: t.tenantId,
          action: 'channel.telegram_disconnected',
        },
      }),
    ).toBe(0);

    telegram.fail('deleteWebhook', null);
    await controller.disconnect(t.request, id);
    expect(telegram.webhooks.size).toBe(0);
    expect(await store.exists(owner, 'bot_token')).toBe(false);
    expect(await store.exists(owner, 'webhook_secret')).toBe(false);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: t.tenantId,
          action: 'channel.telegram_disconnected',
        },
      }),
    ).toBe(1);
  });

  it('disconnects even when Telegram no longer accepts the token (revoked)', async () => {
    const { bots, controller, store } = setup();
    const t = await tenant();
    bots.set(TOKEN(RUN + 841), { id: RUN + 841, username: 'revoked_bot' });
    const { id } = await controller.connect(t.request, {
      botToken: TOKEN(RUN + 841),
    });
    bots.delete(TOKEN(RUN + 841));
    await controller.disconnect(t.request, id);
    const owner = { tenantId: t.tenantId, channelAccountId: id };
    expect(await store.exists(owner, 'bot_token')).toBe(false);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: t.tenantId, action: 'channel.telegram_disconnected' },
    });
    expect(audit.safeInputSummary).toMatchObject({ webhook: 'token_unusable' });
  });
});
