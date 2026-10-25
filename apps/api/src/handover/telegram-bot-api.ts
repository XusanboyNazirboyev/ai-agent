import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import {
  TELEGRAM_FETCH,
  TelegramAmbiguousSendError,
  TelegramApiError,
  type TelegramFetch,
} from '../channels/telegram/telegram-sender.js';
import { TelegramCredentials } from '../channels/telegram/telegram-credentials.js';

/**
 * Thin Bot API client for operator-group traffic. Methods and fields follow
 * https://core.telegram.org/bots/api (read 2026-10-24): sendMessage
 * (chat_id, text 1-4096, reply_markup, reply_parameters), InlineKeyboardMarkup
 * (inline_keyboard; callback_data 1-64 bytes), answerCallbackQuery
 * (callback_query_id, text 0-200), editMessageReplyMarkup. The token is read
 * from configuration and never logged. Not exercised against the real API in
 * this repository's tests (a mocked transport is used).
 */
export interface InlineButton {
  readonly text: string;
  readonly callbackData: string;
}

@Injectable()
export class TelegramBotApi {
  private readonly token: string | undefined;
  private readonly request: TelegramFetch;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    @Optional() @Inject(TELEGRAM_FETCH) request?: TelegramFetch,
    @Optional() private readonly credentials?: TelegramCredentials,
  ) {
    this.token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.request = request ?? fetch;
  }

  get configured(): boolean {
    return this.token !== undefined && this.token !== '';
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    channelAccountId?: string,
  ): Promise<unknown> {
    const token =
      channelAccountId && this.credentials
        ? await this.credentials.tokenFor(channelAccountId)
        : this.token;
    if (!token) throw new Error('Telegram bot is not configured');
    let response: Response;
    let body: unknown;
    try {
      response = await this.request(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(10_000),
        },
      );
      body = await response.json();
    } catch {
      throw new TelegramAmbiguousSendError();
    }
    const parsed = body as {
      ok?: unknown;
      result?: unknown;
      error_code?: unknown;
      parameters?: { retry_after?: unknown };
    } | null;
    if (!parsed || typeof parsed.ok !== 'boolean')
      throw new TelegramAmbiguousSendError();
    if (!response.ok || !parsed.ok) {
      const retry = parsed.parameters?.retry_after;
      throw new TelegramApiError(
        typeof parsed.error_code === 'number'
          ? parsed.error_code
          : response.status,
        typeof retry === 'number' && Number.isFinite(retry) ? retry : null,
      );
    }
    return parsed.result;
  }

  async sendMessage(options: {
    chatId: string;
    text: string;
    replyToMessageId?: string;
    buttons?: readonly (readonly InlineButton[])[];
    /** The account whose bot posts; without it the environment bot is used. */
    channelAccountId?: string;
  }): Promise<{ messageId: string }> {
    if (options.text.length === 0 || options.text.length > 4_096)
      throw new RangeError('Telegram text must contain 1 to 4096 characters');
    const result = (await this.call(
      'sendMessage',
      {
        chat_id: options.chatId,
        text: options.text,
        ...(options.replyToMessageId
          ? {
              reply_parameters: {
                message_id: Number(options.replyToMessageId),
                allow_sending_without_reply: true,
              },
            }
          : {}),
        ...(options.buttons
          ? { reply_markup: inlineKeyboard(options.buttons) }
          : {}),
      },
      options.channelAccountId,
    )) as { message_id?: unknown } | null;
    if (!result || typeof result.message_id !== 'number')
      throw new TelegramAmbiguousSendError();
    return { messageId: String(result.message_id) };
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text: string,
    channelAccountId?: string,
  ): Promise<void> {
    await this.call(
      'answerCallbackQuery',
      {
        callback_query_id: callbackQueryId,
        text: text.slice(0, 200),
      },
      channelAccountId,
    );
  }

  async editReplyMarkup(
    chatId: string,
    messageId: string,
    buttons: readonly (readonly InlineButton[])[],
    channelAccountId?: string,
  ): Promise<void> {
    await this.call(
      'editMessageReplyMarkup',
      {
        chat_id: chatId,
        message_id: Number(messageId),
        reply_markup: inlineKeyboard(buttons),
      },
      channelAccountId,
    );
  }
}

export function inlineKeyboard(rows: readonly (readonly InlineButton[])[]): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => {
        // callback_data is 1-64 bytes (Bot API): refuse anything longer.
        if (Buffer.byteLength(button.callbackData) > 64)
          throw new RangeError('callback_data exceeds 64 bytes');
        return { text: button.text, callback_data: button.callbackData };
      }),
    ),
  };
}
