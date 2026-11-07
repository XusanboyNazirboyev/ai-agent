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

  /**
   * ADR 042: downloads a voice note (Bot API, read 2026-11-07): `getFile`
   * returns `file_path`; the file is then at
   * `https://api.telegram.org/file/bot<token>/<file_path>`, valid for at least
   * one hour, at most 20 MB. The URL holds the bot token: it is never logged
   * or returned. Returns null when the file is missing, too large or the
   * download fails; the caller treats that as an unreadable voice note.
   */
  async downloadFile(
    fileId: string,
    maxBytes: number,
    channelAccountId?: string,
  ): Promise<Uint8Array | null> {
    const token =
      channelAccountId && this.credentials
        ? await this.credentials.tokenFor(channelAccountId)
        : this.token;
    if (!token) throw new Error('Telegram sender is not configured');
    try {
      const info = await this.request(
        `https://api.telegram.org/bot${token}/getFile`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file_id: fileId }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = (await info.json()) as {
        ok?: unknown;
        result?: { file_path?: unknown; file_size?: unknown };
      };
      const path = body?.result?.file_path;
      const size = body?.result?.file_size;
      if (
        !info.ok ||
        body?.ok !== true ||
        typeof path !== 'string' ||
        !/^[A-Za-z0-9_./-]{1,300}$/u.test(path) ||
        path.includes('..') ||
        (typeof size === 'number' && size > maxBytes)
      )
        return null;
      const file = await this.request(
        `https://api.telegram.org/file/bot${token}/${path}`,
        { method: 'GET', signal: AbortSignal.timeout(20_000) },
      );
      const declared = Number(file.headers.get('content-length') ?? '0');
      if (!file.ok || declared > maxBytes) return null;
      const bytes = new Uint8Array(await file.arrayBuffer());
      return bytes.byteLength > 0 && bytes.byteLength <= maxBytes
        ? bytes
        : null;
    } catch {
      return null;
    }
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
