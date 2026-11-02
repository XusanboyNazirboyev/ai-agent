import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { PrismaConnectorSecretStore } from '../../secrets/connector-secret-store.js';
import { createKeyring, SecretCipher } from '../../secrets/secret-cipher.js';
import { Bitrix24Connector } from '../bitrix24/bitrix24-connector.js';
import { ConnectorRegistry } from '../registry/connector-registry.js';
import { bitrix24ConnectorRegistration } from '../registry/registrations.js';
import {
  storeReferences,
  TenantConnectorLoader,
} from './tenant-connector-loader.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Stored secret tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const REF = 'store:bitrix24_webhook_url';
const url = (): string =>
  `https://portal-${randomUUID().slice(0, 8)}.bitrix24.test/rest/7/${randomBytes(8).toString('hex')}/`;

function world(): {
  loader: TenantConnectorLoader;
  store: PrismaConnectorSecretStore;
  resolved: (string | undefined)[];
} {
  const resolved: (string | undefined)[] = [];
  const registry = new ConnectorRegistry({
    resolve: (): undefined => undefined,
  });
  const real = bitrix24ConnectorRegistration();
  registry.register({
    ...real,
    factory: (context, config, dependencies) => {
      resolved.push(
        dependencies.resolveSecret.resolve(
          (config as { webhookSecretRef: string }).webhookSecretRef,
        ),
      );
      return new Bitrix24Connector(context, config, {
        resolveSecret: dependencies.resolveSecret,
      });
    },
  });
  const store = new PrismaConnectorSecretStore(
    prisma,
    new SecretCipher(
      createKeyring({
        SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
      }),
    ),
  );
  return {
    loader: new TenantConnectorLoader(prisma, registry, store),
    store,
    resolved,
  };
}

async function bitrixRow(): Promise<
  Awaited<ReturnType<typeof db.tenantConnector.create>>
> {
  const tenant = await db.tenant.create({
    data: {
      slug: `ss-${randomUUID()}`,
      name: 'Stored secret fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  return db.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: 'bitrix24',
      status: 'ACTIVE',
      config: { webhookSecretRef: REF },
    },
  });
}

describe('store: references in connector config (ADR 032)', () => {
  it('finds store references anywhere in a config and nothing else', () => {
    expect(
      storeReferences({
        webhookSecretRef: REF,
        auth: { secretRef: 'env:CONNECTOR_SECRET_X' },
        list: ['store:other_thing', 'store:Bad', 'nope'],
      }),
    ).toEqual(['store:bitrix24_webhook_url', 'store:other_thing']);
  });

  it("resolves a row's reference to its own stored value and rebuilds after a reconnect", async () => {
    const { loader, store, resolved } = world();
    const row = await bitrixRow();
    const owner = { tenantId: row.tenantId, tenantConnectorId: row.id };
    const first = url();
    await store.put(owner, 'bitrix24_webhook_url', first);
    const a = await loader.create(row);
    const b = await loader.create(row);
    expect(b).toBe(a);
    expect(resolved).toEqual([first]);

    const second = url();
    await store.put(owner, 'bitrix24_webhook_url', second);
    const c = await loader.create(row);
    expect(c).not.toBe(a);
    expect(resolved).toEqual([first, second]);
  });

  it("never uses another tenant's secret, and fails closed without a store", async () => {
    const { loader, store } = world();
    const a = await bitrixRow();
    const b = await bitrixRow();
    await store.put(
      { tenantId: a.tenantId, tenantConnectorId: a.id },
      'bitrix24_webhook_url',
      url(),
    );
    await expect(loader.create(b)).rejects.toMatchObject({
      code: 'CONNECTOR_SECRET_MISSING',
    });

    const registry = new ConnectorRegistry({
      resolve: (): undefined => undefined,
    });
    registry.register(bitrix24ConnectorRegistration());
    await expect(
      new TenantConnectorLoader(prisma, registry).create(a),
    ).rejects.toMatchObject({ code: 'CONNECTOR_SECRET_MISSING' });
  });
});
