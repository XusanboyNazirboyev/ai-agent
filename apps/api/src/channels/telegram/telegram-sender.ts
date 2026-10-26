import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import { TelegramCredentials } from './telegram-credentials.js';

export class TelegramApiError extends Error {
  constructor(
    readonly errorCode: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Telegram API returned error ${errorCode}`);
    this.name = 'TelegramApiError';
  }
}

export class TelegramAmbiguousSendError extends Error {
  constructor() {
    super('Telegram send outcome is ambiguous');
    this.name = 'TelegramAmbiguousSendError';
  }
}

export type TelegramSendResult = { messageId: string };
export type TelegramFetch = typeof fetch;

/**
 * Optional DI token for the Bot API transport. A plain `typeof fetch`
 * parameter is emitted as a `Function` token Nest cannot resolve, so the
 * transport is injected explicitly; production uses the global `fetch`.
 */
export const TELEGRAM_FETCH = Symbol('TELEGRAM_FETCH');

@Injectable()
export class TelegramSender {
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

  /** `channelAccountId` selects that account's bot; without it the environment bot is used. */
  async sendMessage(
    chatId: string,
    text: string,
    channelAccountId?: string,
  ): Promise<TelegramSendResult> {
    if (text.length === 0 || text.length > 4_096) {
      throw new RangeError('Telegram text must contain 1 to 4096 characters');
    }
    const token =
      channelAccountId && this.credentials
        ? await this.credentials.tokenFor(channelAccountId)
        : this.token;
    if (!token) throw new Error('Telegram sender is not configured');

    let response: Response;
    let body: unknown;
    try {
      response = await this.request(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      body = await response.json();
    } catch {
      // A timeout or lost response may happen after Telegram accepted the send.
      throw new TelegramAmbiguousSendError();
    }

    if (
      !body ||
      typeof body !== 'object' ||
      !('ok' in body) ||
      typeof body.ok !== 'boolean'
    ) {
      throw new TelegramAmbiguousSendError();
    }
    if (!response.ok || !body.ok) {
      const telegramBody = body as {
        error_code?: unknown;
        parameters?: { retry_after?: unknown };
      };
      const code =
        typeof telegramBody.error_code === 'number'
          ? telegramBody.error_code
          : response.status;
      const retryAfter = telegramBody.parameters?.retry_after;
      throw new TelegramApiError(
        code,
        typeof retryAfter === 'number' && Number.isFinite(retryAfter)
          ? retryAfter
          : null,
      );
    }

    const result = (body as { result?: { message_id?: unknown } }).result;
    if (!result || typeof result.message_id !== 'number') {
      throw new TelegramAmbiguousSendError();
    }
    return { messageId: String(result.message_id) };
  }
}
