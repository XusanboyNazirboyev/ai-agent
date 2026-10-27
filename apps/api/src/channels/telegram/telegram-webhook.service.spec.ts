import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../../config/environment.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { ChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { TelegramCredentials } from './telegram-credentials.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

const ENV_ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';

function config(secret?: string): ConfigService<AppEnvironment, true> {
  return {
    get: (key: string) =>
      key === 'TELEGRAM_WEBHOOK_SECRET'
        ? secret
        : key === 'TELEGRAM_CHANNEL_ACCOUNT_ID' && secret
          ? ENV_ACCOUNT
          : undefined,
  } as unknown as ConfigService<AppEnvironment, true>;
}

function makeService(secret?: string): TelegramWebhookService {
  return new TelegramWebhookService({} as PrismaService, config(secret));
}

/** A store holding one account's secrets, as the web UI would have saved them. */
function serviceWithStore(stored: string): TelegramWebhookService {
  const prisma = {
    channelAccount: {
      findFirst: () => Promise.resolve({ tenantId: 'tenant-1' }),
    },
  } as unknown as PrismaService;
  const store = {
    configured: true,
    get: (owner: { channelAccountId: string }, purpose: string) =>
      Promise.resolve(
        owner.channelAccountId === OTHER_ACCOUNT && purpose === 'webhook_secret'
          ? stored
          : undefined,
      ),
  } as unknown as ChannelSecretStore;
  return new TelegramWebhookService(
    prisma,
    config('env-secret'),
    new TelegramCredentials(prisma, config('env-secret'), store),
  );
}

describe('TelegramWebhookService secret validation', () => {
  it('accepts the configured secret for the configured account only', async () => {
    await expect(
      makeService('shared-secret').assertWebhookSecret(
        ENV_ACCOUNT,
        'shared-secret',
      ),
    ).resolves.toBeUndefined();
    await expect(
      makeService('shared-secret').assertWebhookSecret(
        OTHER_ACCOUNT,
        'shared-secret',
      ),
    ).rejects.toThrow('not configured');
  });

  it('rejects missing and invalid secrets and fails closed when unconfigured', async () => {
    await expect(
      makeService('shared-secret').assertWebhookSecret(ENV_ACCOUNT, undefined),
    ).rejects.toThrow('Invalid');
    await expect(
      makeService('shared-secret').assertWebhookSecret(ENV_ACCOUNT, 'other'),
    ).rejects.toThrow('Invalid');
    await expect(
      makeService().assertWebhookSecret(ENV_ACCOUNT, 'anything'),
    ).rejects.toThrow('not configured');
    await expect(
      makeService('shared-secret').assertWebhookSecret('not-a-uuid', 'x'),
    ).rejects.toThrow('not configured');
  });

  it('uses the secret saved for the account, and a bot connected from the UI is not the environment one', async () => {
    const service = serviceWithStore('stored-secret');
    await expect(
      service.assertWebhookSecret(OTHER_ACCOUNT, 'stored-secret'),
    ).resolves.toBeUndefined();
    await expect(
      service.assertWebhookSecret(OTHER_ACCOUNT, 'env-secret'),
    ).rejects.toThrow('Invalid');
    // The environment account still uses the environment secret.
    await expect(
      service.assertWebhookSecret(ENV_ACCOUNT, 'env-secret'),
    ).resolves.toBeUndefined();
  });
});
