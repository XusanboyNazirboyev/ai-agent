import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../../config/environment.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

function makeService(secret?: string): TelegramWebhookService {
  const config = {
    get: (key: string) =>
      key === 'TELEGRAM_WEBHOOK_SECRET' ? secret : undefined,
  } as unknown as ConfigService<AppEnvironment, true>;
  return new TelegramWebhookService({} as PrismaService, config);
}

describe('TelegramWebhookService secret validation', () => {
  it('accepts the configured secret', () => {
    expect(() =>
      makeService('shared-secret').assertWebhookSecret('shared-secret'),
    ).not.toThrow();
  });

  it('rejects missing and invalid secrets and fails closed when unconfigured', () => {
    expect(() =>
      makeService('shared-secret').assertWebhookSecret(undefined),
    ).toThrow();
    expect(() =>
      makeService('shared-secret').assertWebhookSecret('other'),
    ).toThrow();
    expect(() => makeService().assertWebhookSecret('anything')).toThrow();
  });
});
