import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { SecretCipher } from './secret-cipher.js';

export type SecretPurpose = 'bot_token' | 'webhook_secret';

export class SecretsNotConfiguredError extends Error {
  constructor() {
    super('SECRETS_MASTER_KEY is not set: channel secrets cannot be stored');
    this.name = 'SecretsNotConfiguredError';
  }
}

export const SECRET_CIPHER = Symbol('SECRET_CIPHER');

/**
 * Per-account secrets, encrypted at rest (ADR 028). The interface is small on
 * purpose so a KMS or Vault implementation can replace this one. Plaintext is
 * returned only to server code that must call the provider; it is never part
 * of a response, a log line or an audit row.
 */
export abstract class ChannelSecretStore {
  abstract readonly configured: boolean;
  abstract put(
    owner: { tenantId: string; channelAccountId: string },
    purpose: SecretPurpose,
    value: string,
  ): Promise<void>;
  abstract get(
    owner: { tenantId: string; channelAccountId: string },
    purpose: SecretPurpose,
  ): Promise<string | undefined>;
  abstract exists(
    owner: { tenantId: string; channelAccountId: string },
    purpose: SecretPurpose,
  ): Promise<boolean>;
  abstract deleteAll(owner: {
    tenantId: string;
    channelAccountId: string;
  }): Promise<void>;
}

const aad = (
  owner: { tenantId: string; channelAccountId: string },
  purpose: SecretPurpose,
): string => `${owner.tenantId}:${owner.channelAccountId}:${purpose}`;

@Injectable()
export class PrismaChannelSecretStore extends ChannelSecretStore {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SECRET_CIPHER) private readonly cipher?: SecretCipher,
  ) {
    super();
  }

  get configured(): boolean {
    return this.cipher !== undefined;
  }

  private requireCipher(): SecretCipher {
    if (!this.cipher) throw new SecretsNotConfiguredError();
    return this.cipher;
  }

  async put(
    owner: { tenantId: string; channelAccountId: string },
    purpose: SecretPurpose,
    value: string,
  ): Promise<void> {
    const sealed = this.requireCipher().seal(value, aad(owner, purpose));
    await this.prisma.channelSecret.upsert({
      where: {
        tenantId_channelAccountId_purpose: {
          tenantId: owner.tenantId,
          channelAccountId: owner.channelAccountId,
          purpose,
        },
      },
      create: {
        tenantId: owner.tenantId,
        channelAccountId: owner.channelAccountId,
        purpose,
        keyId: sealed.keyId,
        nonce: Uint8Array.from(sealed.nonce),
        ciphertext: Uint8Array.from(sealed.ciphertext),
      },
      update: {
        keyId: sealed.keyId,
        nonce: Uint8Array.from(sealed.nonce),
        ciphertext: Uint8Array.from(sealed.ciphertext),
      },
    });
  }

  async get(
    owner: { tenantId: string; channelAccountId: string },
    purpose: SecretPurpose,
  ): Promise<string | undefined> {
    const row = await this.prisma.channelSecret.findUnique({
      where: {
        tenantId_channelAccountId_purpose: {
          tenantId: owner.tenantId,
          channelAccountId: owner.channelAccountId,
          purpose,
        },
      },
    });
    if (!row) return undefined;
    return this.requireCipher().open(
      {
        keyId: row.keyId,
        nonce: Buffer.from(row.nonce),
        ciphertext: Buffer.from(row.ciphertext),
      },
      aad(owner, purpose),
    );
  }

  async exists(
    owner: { tenantId: string; channelAccountId: string },
    purpose: SecretPurpose,
  ): Promise<boolean> {
    return (
      (await this.prisma.channelSecret.count({
        where: {
          tenantId: owner.tenantId,
          channelAccountId: owner.channelAccountId,
          purpose,
        },
      })) > 0
    );
  }

  async deleteAll(owner: {
    tenantId: string;
    channelAccountId: string;
  }): Promise<void> {
    await this.prisma.channelSecret.deleteMany({
      where: {
        tenantId: owner.tenantId,
        channelAccountId: owner.channelAccountId,
      },
    });
  }
}
