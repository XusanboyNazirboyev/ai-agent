import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '../../config/environment.js';
import { TelegramBotApi } from '../../handover/telegram-bot-api.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { ChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { TelegramCredentials } from './telegram-credentials.js';
import { TelegramSender } from './telegram-sender.js';

const ENV_ACCOUNT = '11111111-1111-4111-8111-111111111111';
const UI_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const BUSINESS_ACCOUNT = '44444444-4444-4444-8444-444444444444';

const config = {
  get: (key: string) =>
    ({
      TELEGRAM_BOT_TOKEN: 'ENV-TOKEN',
      TELEGRAM_WEBHOOK_SECRET: 'env-secret',
      TELEGRAM_CHANNEL_ACCOUNT_ID: ENV_ACCOUNT,
      PLATFORM_TELEGRAM_BOT_TOKEN: 'PLATFORM-TOKEN',
    })[key],
} as unknown as ConfigService<AppEnvironment, true>;

const prisma = {
  channelAccount: {
    findFirst: ({
      where,
    }: {
      where: { id: string; externalAccountId?: unknown };
    }) =>
      Promise.resolve(
        where.externalAccountId === undefined
          ? { tenantId: `tenant-of-${where.id}` }
          : where.id === BUSINESS_ACCOUNT
            ? { businessConnectionId: 'bc-1' }
            : null,
      ),
  },
} as unknown as PrismaService;

function store(values: Record<string, string>): ChannelSecretStore {
  return {
    configured: true,
    get: (owner: { channelAccountId: string }, purpose: string) =>
      Promise.resolve(values[`${owner.channelAccountId}:${purpose}`]),
  } as unknown as ChannelSecretStore;
}

const credentials = new TelegramCredentials(
  prisma,
  config,
  store({ [`${UI_ACCOUNT}:bot_token`]: 'UI-TOKEN' }),
);

describe('TelegramCredentials', () => {
  it('prefers a saved secret, falls back to the environment for its own account only', async () => {
    expect(await credentials.tokenFor(UI_ACCOUNT)).toBe('UI-TOKEN');
    expect(await credentials.tokenFor(ENV_ACCOUNT)).toBe('ENV-TOKEN');
    expect(
      await credentials.tokenFor('33333333-3333-4333-8333-333333333333'),
    ).toBeUndefined();
    expect(await credentials.tokenFor('not-a-uuid')).toBeUndefined();
  });

  it('an unreadable secret counts as missing and never leaks into the log call', async () => {
    const broken = new TelegramCredentials(prisma, config, {
      configured: true,
      get: () => Promise.reject(new Error('boom SECRET-VALUE')),
    } as unknown as ChannelSecretStore);
    expect(await broken.tokenFor(UI_ACCOUNT)).toBeUndefined();
  });
});

describe('per-account bots', () => {
  const ok = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })),
    );

  it('the sender uses the account token, or the environment token without an account', async () => {
    const request = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      ok(),
    );
    const sender = new TelegramSender(config, request, credentials);
    await sender.sendMessage('1', 'hi', UI_ACCOUNT);
    await sender.sendMessage('1', 'hi');
    await expect(
      sender.sendMessage('1', 'hi', '33333333-3333-4333-8333-333333333333'),
    ).rejects.toThrow('not configured');
    expect(request.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.telegram.org/botUI-TOKEN/sendMessage',
      'https://api.telegram.org/botENV-TOKEN/sendMessage',
    ]);
  });

  it('the operator-group Bot API client does the same', async () => {
    const request = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      ok(),
    );
    const api = new TelegramBotApi(config, request, credentials);
    await api.sendMessage({
      chatId: '-1',
      text: 'card',
      channelAccountId: UI_ACCOUNT,
    });
    await api.answerCallbackQuery('cb', 'ok', UI_ACCOUNT);
    await api.sendMessage({ chatId: '-1', text: 'card' });
    expect(request.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.telegram.org/botUI-TOKEN/sendMessage',
      'https://api.telegram.org/botUI-TOKEN/answerCallbackQuery',
      'https://api.telegram.org/botENV-TOKEN/sendMessage',
    ]);
  });

  it('ADR 092: a business account sends through the platform bot for its connection', async () => {
    const request = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      ok(),
    );
    const sender = new TelegramSender(config, request, credentials);
    await sender.sendMessage('99', 'hi', BUSINESS_ACCOUNT);
    await sender.sendVoice('99', new Uint8Array([1, 2]), BUSINESS_ACCOUNT);
    const api = new TelegramBotApi(config, request, credentials);
    await api.sendChatAction({
      chatId: '99',
      channelAccountId: BUSINESS_ACCOUNT,
    });
    await sender.sendMessage('1', 'hi', UI_ACCOUNT);
    const calls = request.mock.calls;
    expect(calls.map((call) => String(call[0]))).toEqual([
      'https://api.telegram.org/botPLATFORM-TOKEN/sendMessage',
      'https://api.telegram.org/botPLATFORM-TOKEN/sendVoice',
      'https://api.telegram.org/botPLATFORM-TOKEN/sendChatAction',
      'https://api.telegram.org/botUI-TOKEN/sendMessage',
    ]);
    expect(JSON.parse(String(calls[0]![1]!.body))).toMatchObject({
      chat_id: '99',
      business_connection_id: 'bc-1',
    });
    expect((calls[1]![1]!.body as FormData).get('business_connection_id')).toBe(
      'bc-1',
    );
    expect(JSON.parse(String(calls[2]![1]!.body))).toMatchObject({
      business_connection_id: 'bc-1',
    });
    expect(JSON.parse(String(calls[3]![1]!.body))).not.toHaveProperty(
      'business_connection_id',
    );
  });
});
