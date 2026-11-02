import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { SecretsNotConfiguredError } from './channel-secret-store.js';
import { PrismaConnectorSecretStore } from './connector-secret-store.js';
import {
  createKeyring,
  SecretCipher,
  SecretDecryptionError,
} from './secret-cipher.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Secret store integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const cipher = (): SecretCipher =>
  new SecretCipher(
    createKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64') }),
  );

// Synthetic, per run: never a real portal or code.
const url = (): string =>
  `https://example-${randomUUID().slice(0, 8)}.bitrix24.test/rest/1/${randomBytes(8).toString('hex')}/`;

async function connector(): Promise<{
  tenantId: string;
  tenantConnectorId: string;
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `csec-${suffix}`,
      name: 'Connector secrets fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const row = await db.tenantConnector.create({
    data: { tenantId: tenant.id, connectorKey: 'bitrix24', status: 'DISABLED' },
  });
  return { tenantId: tenant.id, tenantConnectorId: row.id };
}

describe('ConnectorSecretStore', () => {
  it('stores only ciphertext, round-trips, and gets a new version when replaced', async () => {
    const store = new PrismaConnectorSecretStore(prisma, cipher());
    const owner = await connector();
    const first = url();
    await store.put(owner, 'bitrix24_webhook_url', first);
    const row = await db.connectorSecret.findFirstOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(Buffer.from(row.ciphertext).toString('latin1')).not.toContain(
      'bitrix24.test',
    );
    const read = await store.read(owner, 'bitrix24_webhook_url');
    expect(read?.value).toBe(first);
    expect(await store.exists(owner, 'bitrix24_webhook_url')).toBe(true);

    const second = url();
    await store.put(owner, 'bitrix24_webhook_url', second);
    const again = await store.read(owner, 'bitrix24_webhook_url');
    expect(again?.value).toBe(second);
    expect(again?.version).not.toBe(read?.version);
    expect(
      await db.connectorSecret.count({ where: { tenantId: owner.tenantId } }),
    ).toBe(1);
  });

  it('a value copied to another connector or tenant does not decrypt', async () => {
    const store = new PrismaConnectorSecretStore(prisma, cipher());
    const a = await connector();
    const b = await connector();
    await store.put(a, 'bitrix24_webhook_url', url());
    const sealed = await db.connectorSecret.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    await db.connectorSecret.create({
      data: {
        tenantId: b.tenantId,
        tenantConnectorId: b.tenantConnectorId,
        purpose: 'bitrix24_webhook_url',
        keyId: sealed.keyId,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
      },
    });
    await expect(store.read(b, 'bitrix24_webhook_url')).rejects.toThrow(
      SecretDecryptionError,
    );
    // The owner's own value still opens, and tenant B never sees it by id.
    expect(
      await store.read(
        { tenantId: b.tenantId, tenantConnectorId: a.tenantConnectorId },
        'bitrix24_webhook_url',
      ),
    ).toBeUndefined();
  });

  it('refuses to write without a key, forgets on deleteAll and cascades with the connector', async () => {
    const owner = await connector();
    await expect(
      new PrismaConnectorSecretStore(prisma).put(
        owner,
        'bitrix24_webhook_url',
        url(),
      ),
    ).rejects.toThrow(SecretsNotConfiguredError);
    expect(new PrismaConnectorSecretStore(prisma).configured).toBe(false);

    const store = new PrismaConnectorSecretStore(prisma, cipher());
    await store.put(owner, 'bitrix24_webhook_url', url());
    await store.deleteAll(owner);
    expect(await store.exists(owner, 'bitrix24_webhook_url')).toBe(false);

    await store.put(owner, 'bitrix24_webhook_url', url());
    await db.tenantConnector.delete({ where: { id: owner.tenantConnectorId } });
    expect(
      await db.connectorSecret.count({ where: { tenantId: owner.tenantId } }),
    ).toBe(0);
  });
});
