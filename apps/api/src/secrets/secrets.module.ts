import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import {
  ChannelSecretStore,
  PrismaChannelSecretStore,
  SECRET_CIPHER,
} from './channel-secret-store.js';
import { createKeyring, SecretCipher } from './secret-cipher.js';

/** Encrypted channel secrets (ADR 028). Without SECRETS_MASTER_KEY the store reports itself unconfigured. */
@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: SECRET_CIPHER,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
      ): SecretCipher | undefined => {
        const key = config.get('SECRETS_MASTER_KEY', { infer: true });
        if (!key) return undefined;
        const id = config.get('SECRETS_KEY_ID', { infer: true });
        const previous = config.get('SECRETS_PREVIOUS_KEYS', { infer: true });
        return new SecretCipher(
          createKeyring({
            SECRETS_MASTER_KEY: key,
            ...(id ? { SECRETS_KEY_ID: id } : {}),
            ...(previous ? { SECRETS_PREVIOUS_KEYS: previous } : {}),
          }),
        );
      },
    },
    { provide: ChannelSecretStore, useClass: PrismaChannelSecretStore },
  ],
  exports: [ChannelSecretStore],
})
export class SecretsModule {}
