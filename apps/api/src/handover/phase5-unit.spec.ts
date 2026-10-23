import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { TelegramWebhookController } from '../channels/telegram/telegram-webhook.controller.js';
import type { TelegramWebhookService } from '../channels/telegram/telegram-webhook.service.js';
import {
  TelegramAmbiguousSendError,
  TelegramApiError,
} from '../channels/telegram/telegram-sender.js';
import { normalizeTelegramUpdate } from '../channels/telegram/telegram-normalizer.js';
import { extractPhone } from '../leads/phone.js';
import { handoverButtons } from './handover-notification.service.js';
import { operatorStrings, parseRef, refLine } from './operator-text.js';
import { TelegramBotApi, inlineKeyboard } from './telegram-bot-api.js';
import type { OperatorUpdateHandler } from './operator-update.handler.js';

const TOKEN = 'unit-test-token-0000';
const config = (
  token: string | undefined,
): ConfigService<AppEnvironment, true> =>
  ({ get: () => token }) as unknown as ConfigService<AppEnvironment, true>;

function api(
  respond: (
    url: string,
    body: Record<string, unknown>,
  ) => Response | Promise<Response>,
): {
  api: TelegramBotApi;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    return respond(url, body);
  }) as unknown as typeof fetch;
  return { api: new TelegramBotApi(config(TOKEN), fetcher), calls };
}
const ok = (result: unknown): Response =>
  new Response(JSON.stringify({ ok: true, result }), { status: 200 });

describe('TelegramBotApi (mocked transport; not run against the real API)', () => {
  it('sends a card with an inline keyboard in the documented shape', async () => {
    const { api: bot, calls } = api(() => ok({ message_id: 55 }));
    const posted = await bot.sendMessage({
      chatId: '-100777',
      text: 'card',
      buttons: [[{ text: 'Take', callbackData: 't:abc' }]],
    });
    expect(posted).toEqual({ messageId: '55' });
    expect(calls[0].url).toBe(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    );
    expect(calls[0].body).toEqual({
      chat_id: '-100777',
      text: 'card',
      reply_markup: {
        inline_keyboard: [[{ text: 'Take', callback_data: 't:abc' }]],
      },
    });
  });

  it('threads replies with reply_parameters and answers callbacks within 200 characters', async () => {
    const { api: bot, calls } = api(() => ok(true));
    await bot
      .sendMessage({ chatId: '1', text: 'x', replyToMessageId: '9' })
      .catch(() => undefined);
    expect(calls[0].body.reply_parameters).toEqual({
      message_id: 9,
      allow_sending_without_reply: true,
    });
    await bot.answerCallbackQuery('cb1', 'y'.repeat(500));
    expect(calls[1].url.endsWith('/answerCallbackQuery')).toBe(true);
    expect(calls[1].body.callback_query_id).toBe('cb1');
    expect((calls[1].body.text as string).length).toBe(200);
    await bot.editReplyMarkup('1', '9', [[{ text: 'R', callbackData: 'r:1' }]]);
    expect(calls[2].url.endsWith('/editMessageReplyMarkup')).toBe(true);
    expect(calls[2].body).toMatchObject({ chat_id: '1', message_id: 9 });
  });

  it('enforces the documented limits locally', async () => {
    const { api: bot, calls } = api(() => ok({ message_id: 1 }));
    await expect(bot.sendMessage({ chatId: '1', text: '' })).rejects.toThrow(
      RangeError,
    );
    await expect(
      bot.sendMessage({ chatId: '1', text: 'x'.repeat(4_097) }),
    ).rejects.toThrow(RangeError);
    expect(() =>
      inlineKeyboard([[{ text: 'x', callbackData: 'a'.repeat(65) }]]),
    ).toThrow(RangeError);
    // 64 bytes is the limit: a handover button fits.
    expect(() =>
      handoverButtons('0198f3a4-aaaa-7bbb-8ccc-123456789abc', 'WAITING', 'en'),
    ).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('maps errors without leaking the token', async () => {
    const limited = api(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 7 },
          }),
          { status: 429 },
        ),
    );
    await expect(
      limited.api.sendMessage({ chatId: '1', text: 'x' }),
    ).rejects.toMatchObject({
      errorCode: 429,
      retryAfterSeconds: 7,
    });
    const rejected = api(
      () =>
        new Response(JSON.stringify({ ok: false, error_code: 400 }), {
          status: 400,
        }),
    );
    const error = await rejected.api
      .sendMessage({ chatId: '1', text: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    const lost = new TelegramBotApi(config(TOKEN), (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch);
    await expect(
      lost.sendMessage({ chatId: '1', text: 'x' }),
    ).rejects.toBeInstanceOf(TelegramAmbiguousSendError);
    expect(new TelegramBotApi(config(undefined)).configured).toBe(false);
    await expect(
      new TelegramBotApi(config(undefined)).sendMessage({
        chatId: '1',
        text: 'x',
      }),
    ).rejects.toThrow('not configured');
  });
});

describe('Telegram update normalization for operators', () => {
  it('reads button presses and the message a reply points to', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 1,
        callback_query: {
          id: 'cb',
          from: { id: 5 },
          message: { message_id: 8, chat: { id: -100 } },
          data: 't:abc',
        },
      }),
    ).toEqual({
      kind: 'callback',
      updateId: '1',
      callbackId: 'cb',
      userId: '5',
      chatId: '-100',
      messageId: '8',
      data: 't:abc',
    });
    const reply = normalizeTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 9,
        date: 1,
        chat: { id: -100 },
        from: { id: 5 },
        text: 'hello',
        reply_to_message: { message_id: 8, text: 'ref:abc' },
      },
    });
    expect(reply).toMatchObject({ kind: 'text', replyToText: 'ref:abc' });
  });

  it('ignores a callback without data or message', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 3,
        callback_query: { id: 'x', from: { id: 1 } },
      }),
    ).toEqual({ kind: 'unsupported', updateId: '3' });
  });
});

describe('webhook routing', () => {
  const build = (): {
    controller: TelegramWebhookController;
    accept: ReturnType<typeof vi.fn>;
    handle: ReturnType<typeof vi.fn>;
  } => {
    const accept = vi.fn().mockResolvedValue('accepted');
    const handle = vi.fn().mockResolvedValue(undefined);
    const webhook = {
      assertWebhookSecret: vi.fn(),
      operatorChannel: vi
        .fn()
        .mockResolvedValue({ tenantId: 't', operatorChatId: '-100' }),
      accept,
    } as unknown as TelegramWebhookService;
    return {
      controller: new TelegramWebhookController(webhook, {
        handle,
      } as unknown as OperatorUpdateHandler),
      accept,
      handle,
    };
  };
  const text = (chat: number): unknown => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chat },
      from: { id: 5 },
      text: 'hi',
    },
  });

  it('keeps operator-group traffic out of customer intake', async () => {
    const { controller, accept, handle } = build();
    await controller.receive('acc', 's', text(-100));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });

  it('sends customer chats to intake and ignores callbacks from outside the operator group', async () => {
    const { controller, accept, handle } = build();
    await controller.receive('acc', 's', text(42));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(handle).not.toHaveBeenCalled();
    const result = await controller.receive('acc', 's', {
      update_id: 2,
      callback_query: {
        id: 'c',
        from: { id: 1 },
        message: { message_id: 1, chat: { id: 42 } },
        data: 't:x',
      },
    });
    expect(result).toEqual({ accepted: false, ignored: true });
    expect(handle).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledTimes(1);
  });
});

describe('phone extraction', () => {
  it.each([
    ['+998 90 123 45 67', '+998901234567'],
    ['998901234567', '998901234567'],
    ['Tel: 90 123-45-67', '901234567'],
    ['mening raqamim +998 (90) 123-45-67', '+998901234567'],
  ])('%j -> %j', (text, expected) => {
    expect(extractPhone(text)).toBe(expected);
  });

  it.each([
    ['IELTS kursi 150 dollar, 3 oy, 2 hafta, 5 kun, 9 soat, 7 talaba'],
    ['12345'],
    ['1234567890123456789'],
    [''],
  ])(
    'does not take a number out of a sentence or an implausible length: %j',
    (text) => {
      expect(extractPhone(text)).toBeUndefined();
    },
  );
});

describe('operator text helpers', () => {
  it('round-trips the routing reference and rejects look-alikes', () => {
    const id = '0198f3a4-1234-7abc-8def-0123456789ab';
    expect(parseRef(`Handover\n${refLine(id)}\nmore`)).toBe(id);
    expect(parseRef('ref:not-a-uuid')).toBeUndefined();
    expect(parseRef(undefined)).toBeUndefined();
  });

  it('localizes operator wording and keeps button data within 64 bytes', () => {
    expect(operatorStrings('ru').take).toBe('Взять');
    expect(operatorStrings('uz-Latn').take).toBe('Olish');
    expect(operatorStrings('en').take).toBe('Take over');
    const id = '0198f3a4-1234-7abc-8def-0123456789ab';
    for (const state of ['WAITING', 'ACTIVE'] as const)
      for (const row of handoverButtons(id, state, 'en'))
        for (const button of row)
          expect(Buffer.byteLength(button.callbackData)).toBeLessThanOrEqual(
            64,
          );
  });
});
