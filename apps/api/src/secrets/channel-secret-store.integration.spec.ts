import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  PrismaChannelSecretStore,
  SecretsNotConfiguredError,
} from './channel-secret-store.js';
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

async function account(): Promise<{
  tenantId: string;
  channelAccountId: string;
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `sec-${suffix}`,
      name: 'Secrets fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const channel = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `sec-${suffix}`,
      status: 'DISABLED',
    },
  });
  return { tenantId: tenant.id, channelAccountId: channel.id };
}

describe('ChannelSecretStore', () => {
  it('stores only ciphertext, replaces on put, and forgets on deleteAll', async () => {
    const owner = await account();
    const store = new PrismaChannelSecretStore(prisma, cipher());
    expect(store.configured).toBe(true);
    await store.put(owner, 'bot_token', '123456:PLAINTEXT-TOKEN');
    const row = await db.channelSecret.findFirstOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(Buffer.from(row.ciphertext).toString('latin1')).not.toContain(
      'PLAINTEXT',
    );
    expect(await store.get(owner, 'bot_token')).toBe('123456:PLAINTEXT-TOKEN');
    await store.put(owner, 'bot_token', 'second');
    expect(await store.get(owner, 'bot_token')).toBe('second');
    expect(
      await db.channelSecret.count({ where: { tenantId: owner.tenantId } }),
    ).toBe(1);
    expect(await store.exists(owner, 'webhook_secret')).toBe(false);
    await store.deleteAll(owner);
    expect(await store.get(owner, 'bot_token')).toBeUndefined();
  });

  it('a value copied to another account or purpose does not decrypt', async () => {
    const a = await account();
    const b = await account();
    const store = new PrismaChannelSecretStore(prisma, cipher());
    await store.put(a, 'bot_token', 'secret-of-a');
    const row = await db.channelSecret.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    // Move the stored value under account B (same tenant id is not possible: use its own tenant).
    await db.channelSecret.create({
      data: {
        tenantId: b.tenantId,
        channelAccountId: b.channelAccountId,
        purpose: 'bot_token',
        keyId: row.keyId,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
      },
    });
    await expect(store.get(b, 'bot_token')).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
    await db.channelSecret.update({
      where: { id: row.id },
      data: { purpose: 'webhook_secret' },
    });
    await expect(store.get(a, 'webhook_secret')).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it('refuses to write without a key and cascades with the account', async () => {
    const owner = await account();
    const unconfigured = new PrismaChannelSecretStore(prisma, undefined);
    expect(unconfigured.configured).toBe(false);
    await expect(
      unconfigured.put(owner, 'bot_token', 'x'),
    ).rejects.toBeInstanceOf(SecretsNotConfiguredError);
    const store = new PrismaChannelSecretStore(prisma, cipher());
    await store.put(owner, 'bot_token', 'x');
    await db.channelAccount.delete({ where: { id: owner.channelAccountId } });
    expect(
      await db.channelSecret.count({ where: { tenantId: owner.tenantId } }),
    ).toBe(0);
  });
});
