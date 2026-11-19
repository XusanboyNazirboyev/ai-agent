import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';

export interface BotReplyMarkup {
  readonly keyboard?: readonly (readonly {
    readonly text: string;
    readonly request_contact?: boolean;
  }[])[];
  readonly resize_keyboard?: boolean;
  readonly one_time_keyboard?: boolean;
  readonly remove_keyboard?: boolean;
}

const TIMEOUT_MS = 8_000;

/**
 * Sends the platform bot's few replies (ADR 080). Bot API sendMessage with
 * `reply_markup` ReplyKeyboardMarkup (`request_contact`) or ReplyKeyboardRemove,
 * https://core.telegram.org/bots/api (read 2026-11-19). The token is only ever
 * part of the request URL; it is never logged, and a failure logs no URL.
 * TELEGRAM_API_BASE_URL is the test double (refused in production).
 */
@Injectable()
export class PlatformBotSender {
  private readonly logger = new Logger(PlatformBotSender.name);
  private readonly base: string;
  private readonly token: string | undefined;

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.token = config.get('PLATFORM_TELEGRAM_BOT_TOKEN', { infer: true });
    this.base = (
      config.get('TELEGRAM_API_BASE_URL', { infer: true }) ??
      'https://api.telegram.org'
    ).replace(/\/+$/u, '');
  }

  /** Best effort: the confirmation itself never depends on the reply arriving. */
  async send(
    chatId: string,
    text: string,
    markup?: BotReplyMarkup,
  ): Promise<boolean> {
    if (!this.token) return false;
    try {
      const response = await fetch(
        `${this.base}/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: Number(chatId),
            text,
            ...(markup ? { reply_markup: markup } : {}),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok)
        this.logger.warn(
          `platform bot sendMessage refused (${response.status})`,
        );
      return response.ok;
    } catch {
      this.logger.warn('platform bot sendMessage failed');
      return false;
    }
  }
}
