import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';

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

@Injectable()
export class TelegramSender {
  private readonly token: string | undefined;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly request: TelegramFetch = fetch,
  ) {
    this.token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
  }

  async sendMessage(chatId: string, text: string): Promise<TelegramSendResult> {
    if (text.length === 0 || text.length > 4_096) {
      throw new RangeError('Telegram text must contain 1 to 4096 characters');
    }
    if (!this.token) throw new Error('Telegram sender is not configured');

    let response: Response;
    let body: unknown;
    try {
      response = await this.request(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
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
