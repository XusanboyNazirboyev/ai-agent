import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Bitrix24Connector } from '../connectors/bitrix24/bitrix24-connector.js';
import { INVALID_CREDENTIALS } from '../connectors/bitrix24/testing/bitrix24-fixtures.js';
import { FakePortal } from '../connectors/bitrix24/testing/fake-portal.js';
import { ConnectorUnavailableError } from '../connectors/interfaces/errors.js';
import { ConnectorRegistry } from '../connectors/registry/connector-registry.js';
import {
  bitrix24ConnectorRegistration,
  mockConnectorRegistration,
} from '../connectors/registry/registrations.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { PrismaConnectorSecretStore } from '../secrets/connector-secret-store.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import { ConnectorsController } from './connectors.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Connector API tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Synthetic, per run: never a real portal or code.
const CODE = (): string => randomBytes(8).toString('hex');
const URL_OF = (code: string): string =>
  `https://portal-${code.slice(0, 6)}.bitrix24.test/rest/1/${code}/`;

function setup(options: { withKey?: boolean } = {}): {
  portal: FakePortal;
  controller: ConnectorsController;
  store: PrismaConnectorSecretStore;
} {
  const portal = new FakePortal();
  const store = new PrismaConnectorSecretStore(
    prisma,
    options.withKey === false
      ? undefined
      : new SecretCipher(
          createKeyring({
            SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
          }),
        ),
  );
  return {
    portal,
    store,
    controller: new ConnectorsController(prisma, store, portal.transport),
  };
}

async function tenant(
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' = 'ADMIN',
  withMock = true,
): Promise<{ tenantId: string; operatorId: string; request: never }> {
  const t = await db.tenant.create({
    data: {
      slug: `crm-${randomUUID()}`,
      name: 'CRM connect fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  if (withMock)
    await db.tenantConnector.create({
      data: {
        tenantId: t.id,
        connectorKey: 'mock',
        status: 'ACTIVE',
        config: { sourceSystem: 'mock-education' },
      },
    });
  const operator = await db.operator.create({
    data: { tenantId: t.id, displayName: 'Admin', role },
  });
  return {
    tenantId: t.id,
    operatorId: operator.id,
    request: {
      principal: {
        tenantId: t.id,
        operatorId: operator.id,
        role,
        sessionId: randomUUID(),
      },
    } as never,
  };
}

describe('connecting Bitrix24 from the web (ADR 032)', () => {
  it('checks the portal, stores the URL encrypted, activates the connector and moves leads off the mock', async () => {
    const { portal, controller, store } = setup();
    const t = await tenant();
    const code = CODE();
    const summary = await controller.connectBitrix24(t.request, {
      webhookUrl: `  ${URL_OF(code)}  `,
    });
    expect(summary).toMatchObject({
      connectorKey: 'bitrix24',
      status: 'ACTIVE',
      configured: true,
    });
    expect(JSON.stringify(summary)).not.toContain(code);
    expect(portal.calls.map((c) => c.method)).toEqual([
      'crm.settings.mode.get',
    ]);

    const row = await db.tenantConnector.findUniqueOrThrow({
      where: { id: summary.id },
    });
    expect(row.config).toEqual({
      webhookSecretRef: 'store:bitrix24_webhook_url',
    });
    expect(
      (
        await store.read(
          { tenantId: t.tenantId, tenantConnectorId: row.id },
          'bitrix24_webhook_url',
        )
      )?.value,
    ).toBe(URL_OF(code));
    const sealed = await db.connectorSecret.findFirstOrThrow({
      where: { tenantId: t.tenantId },
    });
    expect(Buffer.from(sealed.ciphertext).toString('latin1')).not.toContain(
      code,
    );
    const mock = await db.tenantConnector.findFirstOrThrow({
      where: { tenantId: t.tenantId, connectorKey: 'mock' },
    });
    expect(mock.config).toMatchObject({ createLead: false });
    const audit = await db.auditEvent.findMany({
      where: { tenantId: t.tenantId },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'connector.bitrix24_connected',
    ]);
    expect(JSON.stringify(audit)).not.toContain(code);

    const listed = await controller.list(t.request);
    expect(listed.secretsConfigured).toBe(true);
    expect(listed.items).toEqual([
      expect.objectContaining({ connectorKey: 'mock', configured: false }),
      expect.objectContaining({ connectorKey: 'bitrix24', configured: true }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(code);

    // A reconnect replaces the URL on the same row.
    const next = CODE();
    const again = await controller.connectBitrix24(t.request, {
      webhookUrl: URL_OF(next),
    });
    expect(again.id).toBe(summary.id);
    expect(
      (
        await store.read(
          { tenantId: t.tenantId, tenantConnectorId: row.id },
          'bitrix24_webhook_url',
        )
      )?.value,
    ).toBe(URL_OF(next));
  });

  it('the saved URL reaches the Bitrix24 connector that lead sync builds', async () => {
    const { portal, controller, store } = setup();
    const t = await tenant();
    const code = CODE();
    const { id } = await controller.connectBitrix24(t.request, {
      webhookUrl: URL_OF(code),
    });
    const seen: (string | undefined)[] = [];
    const registry = new ConnectorRegistry({
      resolve: (): undefined => undefined,
    });
    registry.register(mockConnectorRegistration());
    const real = bitrix24ConnectorRegistration();
    registry.register({
      ...real,
      factory: (context, config, dependencies) => {
        seen.push(
          dependencies.resolveSecret.resolve('store:bitrix24_webhook_url'),
        );
        return new Bitrix24Connector(context, config, {
          resolveSecret: dependencies.resolveSecret,
          client: { transport: portal.transport, minIntervalMs: 0 },
        });
      },
    });
    const loader = new TenantConnectorLoader(prisma, registry, store);
    const row = await db.tenantConnector.findUniqueOrThrow({ where: { id } });
    const connector = await loader.create(row);
    expect(connector.capabilities.createLead).toBe(true);
    expect(seen).toEqual([URL_OF(code)]);
    const mockRow = await db.tenantConnector.findFirstOrThrow({
      where: { tenantId: t.tenantId, connectorKey: 'mock' },
    });
    expect((await loader.create(mockRow)).capabilities.createLead).toBe(false);
  });

  it('refuses a bad URL, a simple-CRM portal, a rejected or unreachable portal, and stores nothing', async () => {
    const t = await tenant();
    const { portal, controller } = setup();
    for (const bad of [
      'not a url',
      'http://portal.bitrix24.test/rest/1/abc123/',
      'https://user:pw@portal.bitrix24.test/rest/1/abc123/',
      'https://portal.bitrix24.test/rest/1/abc123/?x=1',
      'https://portal.bitrix24.test/api/1/abc123/',
    ])
      await expect(
        controller.connectBitrix24(t.request, { webhookUrl: bad }),
      ).rejects.toMatchObject({ response: { code: 'INVALID_WEBHOOK_URL' } });
    expect(portal.calls).toHaveLength(0);
    await expect(
      controller.connectBitrix24(t.request, {}),
    ).rejects.toMatchObject({ response: { code: 'INVALID_BODY' } });

    portal.mode = 2;
    await expect(
      controller.connectBitrix24(t.request, { webhookUrl: URL_OF(CODE()) }),
    ).rejects.toMatchObject({
      response: { code: 'LEADS_DISABLED' },
      status: 409,
    });
    portal.mode = 1;
    portal.queue('crm.settings.mode.get', {
      status: 401,
      body: INVALID_CREDENTIALS,
    });
    await expect(
      controller.connectBitrix24(t.request, { webhookUrl: URL_OF(CODE()) }),
    ).rejects.toMatchObject({ response: { code: 'CRM_REJECTED' } });

    const down = new ConnectorsController(prisma, setup().store, () =>
      Promise.reject(
        new ConnectorUnavailableError({
          message: 'unreachable',
          code: 'CONNECTOR_UNREACHABLE',
        }),
      ),
    );
    await expect(
      down.connectBitrix24(t.request, { webhookUrl: URL_OF(CODE()) }),
    ).rejects.toMatchObject({ response: { code: 'CRM_UNREACHABLE' } });

    expect(
      await db.tenantConnector.count({
        where: { tenantId: t.tenantId, connectorKey: 'bitrix24' },
      }),
    ).toBe(0);
    expect(
      await db.connectorSecret.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
  });

  it('keeps the URL out of log lines and error responses', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation((...args) => {
        logged.push(args.map((a) => String(a)).join(' '));
      });
    const t = await tenant();
    const { portal, controller } = setup();
    const code = CODE();
    const seen: unknown[] = [];
    portal.mode = 2;
    await controller
      .connectBitrix24(t.request, { webhookUrl: URL_OF(code) })
      .catch((e: unknown) => seen.push(e));
    portal.mode = 1;
    portal.queue('crm.settings.mode.get', {
      status: 401,
      body: INVALID_CREDENTIALS,
    });
    await controller
      .connectBitrix24(t.request, { webhookUrl: URL_OF(code) })
      .catch((e: unknown) => seen.push(e));
    expect(seen).toHaveLength(2);
    expect(logged.some((l) => l.includes('bitrix24_check_failed'))).toBe(true);
    const everything = [
      ...logged,
      ...seen.map((e) => {
        const err = e as { message?: string; getResponse?: () => unknown };
        return `${err.message ?? ''} ${JSON.stringify(err.getResponse?.() ?? null)}`;
      }),
    ].join('\n');
    expect(everything).not.toContain(code);
  });

  it('roles, tenant scope, missing key, disable and disconnect', async () => {
    const { controller, store } = setup();
    const a = await tenant();
    const b = await tenant();
    const op = await tenant('OPERATOR');
    const { id } = await controller.connectBitrix24(a.request, {
      webhookUrl: URL_OF(CODE()),
    });
    await expect(controller.list(op.request)).rejects.toMatchObject({
      response: { code: 'FORBIDDEN' },
    });
    for (const attempt of [
      (): Promise<unknown> => controller.disable(b.request, id),
      (): Promise<unknown> => controller.disconnect(b.request, id),
    ])
      await expect(attempt()).rejects.toMatchObject({
        response: { code: 'NOT_FOUND' },
      });
    expect((await controller.list(b.request)).items).toEqual([
      expect.objectContaining({ connectorKey: 'mock' }),
    ]);
    await expect(
      setup({ withKey: false }).controller.connectBitrix24(a.request, {
        webhookUrl: URL_OF(CODE()),
      }),
    ).rejects.toMatchObject({ response: { code: 'SECRETS_NOT_CONFIGURED' } });

    expect(await controller.disable(a.request, id)).toMatchObject({
      status: 'DISABLED',
      configured: true,
    });
    await controller.disconnect(a.request, id);
    expect(
      await store.exists(
        { tenantId: a.tenantId, tenantConnectorId: id },
        'bitrix24_webhook_url',
      ),
    ).toBe(false);
    const actions = (
      await db.auditEvent.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.action);
    expect(actions).toEqual([
      'connector.bitrix24_connected',
      'connector.disabled',
      'connector.disconnected',
    ]);
  });
});
