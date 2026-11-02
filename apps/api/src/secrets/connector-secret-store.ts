import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  SECRET_CIPHER,
  SecretsNotConfiguredError,
} from './channel-secret-store.js';
import { SecretCipher } from './secret-cipher.js';

export type ConnectorSecretPurpose = 'bitrix24_webhook_url';

export interface ConnectorSecretOwner {
  readonly tenantId: string;
  readonly tenantConnectorId: string;
}

export interface StoredConnectorSecret {
  readonly value: string;
  /**
   * Changes whenever the stored value is replaced (a hash of the sealed
   * value, which is never the same twice). Lets a cached connector be
   * rebuilt after a reconnect without exposing anything about the value.
   */
  readonly version: string;
}

/**
 * Per-connector secrets, encrypted at rest (ADR 032), beside the channel
 * secrets of ADR 028 with the same cipher and keyring. Plaintext goes only to
 * server code that calls the CRM; it is never part of a response, a log line
 * or an audit row.
 */
export abstract class ConnectorSecretStore {
  abstract readonly configured: boolean;
  abstract put(
    owner: ConnectorSecretOwner,
    purpose: ConnectorSecretPurpose,
    value: string,
  ): Promise<void>;
  abstract read(
    owner: ConnectorSecretOwner,
    purpose: ConnectorSecretPurpose,
  ): Promise<StoredConnectorSecret | undefined>;
  abstract exists(
    owner: ConnectorSecretOwner,
    purpose: ConnectorSecretPurpose,
  ): Promise<boolean>;
  abstract deleteAll(owner: ConnectorSecretOwner): Promise<void>;
}

/** Bound to the connector row and the purpose; `connector:` keeps it apart from channel secrets. */
const aad = (
  owner: ConnectorSecretOwner,
  purpose: ConnectorSecretPurpose,
): string =>
  `connector:${owner.tenantId}:${owner.tenantConnectorId}:${purpose}`;

@Injectable()
export class PrismaConnectorSecretStore extends ConnectorSecretStore {
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
    owner: ConnectorSecretOwner,
    purpose: ConnectorSecretPurpose,
    value: string,
  ): Promise<void> {
    const sealed = this.requireCipher().seal(value, aad(owner, purpose));
    const data = {
      keyId: sealed.keyId,
      nonce: Uint8Array.from(sealed.nonce),
      ciphertext: Uint8Array.from(sealed.ciphertext),
    };
    await this.prisma.connectorSecret.upsert({
      where: {
        tenantId_tenantConnectorId_purpose: {
          tenantId: owner.tenantId,
          tenantConnectorId: owner.tenantConnectorId,
          purpose,
        },
      },
      create: {
        tenantId: owner.tenantId,
        tenantConnectorId: owner.tenantConnectorId,
        purpose,
        ...data,
      },
      update: data,
    });
  }

  async read(
    owner: ConnectorSecretOwner,
    purpose: ConnectorSecretPurpose,
  ): Promise<StoredConnectorSecret | undefined> {
    const row = await this.prisma.connectorSecret.findUnique({
      where: {
        tenantId_tenantConnectorId_purpose: {
          tenantId: owner.tenantId,
          tenantConnectorId: owner.tenantConnectorId,
          purpose,
        },
      },
    });
    if (!row) return undefined;
    const ciphertext = Buffer.from(row.ciphertext);
    const value = this.requireCipher().open(
      { keyId: row.keyId, nonce: Buffer.from(row.nonce), ciphertext },
      aad(owner, purpose),
    );
    const version = createHash('sha256')
      .update(Buffer.from(row.nonce))
      .update(ciphertext)
      .digest('hex')
      .slice(0, 16);
    return { value, version };
  }

  async exists(
    owner: ConnectorSecretOwner,
    purpose: ConnectorSecretPurpose,
  ): Promise<boolean> {
    return (
      (await this.prisma.connectorSecret.count({
        where: {
          tenantId: owner.tenantId,
          tenantConnectorId: owner.tenantConnectorId,
          purpose,
        },
      })) > 0
    );
  }

  async deleteAll(owner: ConnectorSecretOwner): Promise<void> {
    await this.prisma.connectorSecret.deleteMany({
      where: {
        tenantId: owner.tenantId,
        tenantConnectorId: owner.tenantConnectorId,
      },
    });
  }
}
