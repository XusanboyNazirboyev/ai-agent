import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import { TELEGRAM_FETCH, type TelegramFetch } from './telegram-sender.js';

export type ManagementErrorCode =
  'INVALID_TOKEN' | 'TELEGRAM_UNREACHABLE' | 'TELEGRAM_REJECTED';

/** Never carries the token or Telegram's free-text description. */
export class TelegramManagementError extends Error {
  constructor(readonly code: ManagementErrorCode) {
    super(code);
    this.name = 'TelegramManagementError';
  }
}

/** Bot tokens look like `<digits>:<letters, digits, _ and ->`. */
export const BOT_TOKEN_FORMAT = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/u;

export interface BotIdentity {
  readonly id: string;
  readonly username: string | null;
  readonly name: string;
}

export interface WebhookState {
  readonly url: string;
  readonly pendingUpdateCount: number;
  readonly lastErrorDate: Date | null;
  readonly lastErrorMessage: string | null;
}

/**
 * The few Bot API calls that connect and check a bot (getMe, setWebhook,
 * getWebhookInfo, deleteWebhook). Fixed host, short timeouts, and the token is
 * only ever part of the request URL. Field names follow
 * https://core.telegram.org/bots/api (read 2026-10-25): setWebhook takes `url`
 * (https), `secret_token` (1-256 of A-Z a-z 0-9 _ -, echoed in the header
 * X-Telegram-Bot-Api-Secret-Token), `allowed_updates`, `drop_pending_updates`;
 * getWebhookInfo returns `url`, `pending_update_count`, `last_error_date`,
 * `last_error_message`. The HTTP status Telegram uses for a wrong token (here
 * 401 and 404 both count as "invalid token") is not stated on that page and is
 * unverified against the live service.
 */
@Injectable()
export class TelegramManagement {
  private readonly request: TelegramFetch;
  private readonly base: string;

  constructor(
    @Optional() @Inject(TELEGRAM_FETCH) request?: TelegramFetch,
    @Optional() config?: ConfigService<AppEnvironment, true>,
  ) {
    this.request = request ?? fetch;
    // TELEGRAM_API_BASE_URL exists for tests with a fake Telegram and is
    // refused in production by the environment schema.
    this.base = (
      config?.get('TELEGRAM_API_BASE_URL', { infer: true }) ??
      'https://api.telegram.org'
    ).replace(/\/+$/u, '');
  }

  private async call(
    token: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    let response: Response;
    let body: unknown;
    try {
      response = await this.request(`${this.base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10_000),
      });
      body = await response.json();
    } catch {
      throw new TelegramManagementError('TELEGRAM_UNREACHABLE');
    }
    const parsed = body as { ok?: unknown; result?: unknown } | null;
    if (!parsed || typeof parsed.ok !== 'boolean')
      throw new TelegramManagementError('TELEGRAM_UNREACHABLE');
    if (!response.ok || !parsed.ok) {
      throw new TelegramManagementError(
        response.status === 401 || response.status === 404
          ? 'INVALID_TOKEN'
          : 'TELEGRAM_REJECTED',
      );
    }
    return parsed.result;
  }

  async getMe(token: string): Promise<BotIdentity> {
    const me = (await this.call(token, 'getMe')) as {
      id?: unknown;
      is_bot?: unknown;
      first_name?: unknown;
      username?: unknown;
    } | null;
    if (!me || typeof me.id !== 'number' || me.is_bot !== true)
      throw new TelegramManagementError('TELEGRAM_REJECTED');
    return {
      id: String(me.id),
      username: typeof me.username === 'string' ? me.username : null,
      name: typeof me.first_name === 'string' ? me.first_name : '',
    };
  }

  async setWebhook(
    token: string,
    url: string,
    secretToken: string,
  ): Promise<void> {
    await this.call(token, 'setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  async deleteWebhook(token: string): Promise<void> {
    await this.call(token, 'deleteWebhook', { drop_pending_updates: false });
  }

  async webhookInfo(token: string): Promise<WebhookState> {
    const info = (await this.call(token, 'getWebhookInfo')) as {
      url?: unknown;
      pending_update_count?: unknown;
      last_error_date?: unknown;
      last_error_message?: unknown;
    } | null;
    if (!info) throw new TelegramManagementError('TELEGRAM_REJECTED');
    return {
      url: typeof info.url === 'string' ? info.url : '',
      pendingUpdateCount:
        typeof info.pending_update_count === 'number'
          ? info.pending_update_count
          : 0,
      lastErrorDate:
        typeof info.last_error_date === 'number'
          ? new Date(info.last_error_date * 1000)
          : null,
      lastErrorMessage:
        typeof info.last_error_message === 'string'
          ? info.last_error_message.slice(0, 200)
          : null,
    };
  }
}
