import { Injectable, Logger, Module, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { ChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { SecretsModule } from '../../secrets/secrets.module.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The bot token and webhook secret of one Telegram channel account (ADR 028).
 * Secrets saved from the web UI (encrypted store) win; the environment trio
 * (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_CHANNEL_ACCOUNT_ID)
 * stays as the fallback for the one account it names, so local development and
 * existing deployments keep working. Values are returned only to code that
 * calls Telegram; a secret that cannot be decrypted counts as missing and is
 * logged without any value.
 */
@Injectable()
export class TelegramCredentials {
  private readonly logger = new Logger(TelegramCredentials.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional() private readonly secrets?: ChannelSecretStore,
  ) {}

  private async stored(
    accountId: string,
    purpose: 'bot_token' | 'webhook_secret',
  ): Promise<string | undefined> {
    if (!this.secrets?.configured || !UUID.test(accountId)) return undefined;
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: accountId, channelType: 'telegram' },
      select: { tenantId: true },
    });
    if (!account) return undefined;
    try {
      return await this.secrets.get(
        { tenantId: account.tenantId, channelAccountId: accountId },
        purpose,
      );
    } catch {
      this.logger.error(
        JSON.stringify({
          event: 'telegram.secret_unreadable',
          channelAccountId: accountId,
          purpose,
        }),
      );
      return undefined;
    }
  }

  private fromEnvironment(
    accountId: string,
    key: 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_WEBHOOK_SECRET',
  ): string | undefined {
    const served = this.config.get('TELEGRAM_CHANNEL_ACCOUNT_ID', {
      infer: true,
    });
    if (!served || served !== accountId) return undefined;
    return this.config.get(key, { infer: true });
  }

  async tokenFor(accountId: string): Promise<string | undefined> {
    return (
      (await this.stored(accountId, 'bot_token')) ??
      this.fromEnvironment(accountId, 'TELEGRAM_BOT_TOKEN')
    );
  }

  async webhookSecretFor(accountId: string): Promise<string | undefined> {
    return (
      (await this.stored(accountId, 'webhook_secret')) ??
      this.fromEnvironment(accountId, 'TELEGRAM_WEBHOOK_SECRET')
    );
  }
}

@Module({
  imports: [PersistenceModule, SecretsModule],
  providers: [TelegramCredentials],
  exports: [TelegramCredentials],
})
export class TelegramCredentialsModule {}
