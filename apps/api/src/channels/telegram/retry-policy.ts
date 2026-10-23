import { TelegramApiError } from './telegram-sender.js';

export function telegramRetryDelayMs(
  attemptsMade: number,
  error?: Error,
): number {
  if (
    error instanceof TelegramApiError &&
    error.errorCode === 429 &&
    error.retryAfterSeconds !== null
  ) {
    return Math.min(Math.max(error.retryAfterSeconds * 1_000, 1_000), 300_000);
  }
  return Math.min(1_000 * 2 ** Math.max(attemptsMade - 1, 0), 30_000);
}
