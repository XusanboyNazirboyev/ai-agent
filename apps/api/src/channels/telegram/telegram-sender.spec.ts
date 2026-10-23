import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '../../config/environment.js';
import {
  TelegramAmbiguousSendError,
  TelegramApiError,
  TelegramSender,
} from './telegram-sender.js';
import { telegramRetryDelayMs } from './retry-policy.js';

function makeSender(request: typeof fetch): TelegramSender {
  const config = {
    get: () => 'test-token',
  } as unknown as ConfigService<AppEnvironment, true>;
  return new TelegramSender(config, request);
}

describe('TelegramSender', () => {
  it('sends text through sendMessage and returns the provider message id', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ok: true, result: { message_id: 900 } }),
      );
    const sender = makeSender(request);

    await expect(sender.sendMessage('chat-7', 'hello')).resolves.toEqual({
      messageId: '900',
    });
    expect(request).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: 'chat-7', text: 'hello' }),
      }),
    );
  });

  it('surfaces explicit Telegram rate limits for bounded retry handling', async () => {
    const sender = makeSender(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { ok: false, error_code: 429, parameters: { retry_after: 3 } },
            { status: 429 },
          ),
        ),
    );
    await expect(sender.sendMessage('7', 'hello')).rejects.toMatchObject({
      errorCode: 429,
      retryAfterSeconds: 3,
    } satisfies Partial<TelegramApiError>);
  });

  it('marks a network timeout as ambiguous instead of blindly retrying a send', async () => {
    const sender = makeSender(
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException('timeout', 'AbortError')),
    );
    await expect(sender.sendMessage('7', 'hello')).rejects.toBeInstanceOf(
      TelegramAmbiguousSendError,
    );
  });

  it('rejects invalid outgoing content without making a request', async () => {
    const request = vi.fn<typeof fetch>();
    const sender = makeSender(request);
    await expect(sender.sendMessage('7', '')).rejects.toThrow(RangeError);
    await expect(sender.sendMessage('7', 'x'.repeat(4_097))).rejects.toThrow(
      RangeError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe('telegramRetryDelayMs', () => {
  it('uses bounded exponential backoff and Telegram retry_after when available', () => {
    expect(telegramRetryDelayMs(1)).toBe(1_000);
    expect(telegramRetryDelayMs(5)).toBe(16_000);
    expect(telegramRetryDelayMs(20)).toBe(30_000);
    expect(telegramRetryDelayMs(1, new TelegramApiError(429, 3))).toBe(3_000);
    expect(telegramRetryDelayMs(1, new TelegramApiError(429, 900))).toBe(
      300_000,
    );
  });
});
