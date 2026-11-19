import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AmocrmConnector } from '../connectors/amocrm/amocrm-connector.js';
import {
  MAIN_PIPELINE_ID,
  SECOND_PIPELINE_ID,
} from '../connectors/amocrm/testing/amocrm-fixtures.js';
import { FakeAccount } from '../connectors/amocrm/testing/fake-account.js';
import { ConnectorRegistry } from '../connectors/registry/connector-registry.js';
import {
  amocrmConnectorRegistration,
  mockConnectorRegistration,
} from '../connectors/registry/registrations.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { PrismaConnectorSecretStore } from '../secrets/connector-secret-store.js';
import { createKeyring, SecretCipher } from '../secrets/secret-cipher.js';
import { AmocrmController } from './amocrm.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const database = process.env.TEST_POSTGRES_DATABASE ?? '';
if (
  !/^agentcore_[a-z0-9_]+$/u.test(database) ||
  database === process.env.POSTGRES_DATABASE
)
  throw new Error('requires a dedicated agentcore_* test database');
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});
afterEach(() => vi.restoreAllMocks());

function setup(account: FakeAccount): {
  controller: AmocrmController;
  store: PrismaConnectorSecretStore;
} {
  const store = new PrismaConnectorSecretStore(
    prisma,
    new SecretCipher(
      createKeyring({
        SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
      }),
    ),
  );
  const registry = new ConnectorRegistry({
    resolve: (): undefined => undefined,
  });
  registry.register(mockConnectorRegistration());
  registry.register({
    ...amocrmConnectorRegistration(),
    factory: (context, config, dependencies) =>
      new AmocrmConnector(context, config, {
        resolveSecret: dependencies.resolveSecret,
        client: {
          transport: account.transport,
          minIntervalMs: 0,
          maxRateRetries: 0,
          sleep: async (): Promise<void> => undefined,
        },
      }),
  });
  const loader = new TenantConnectorLoader(prisma, registry, store);
  return {
    store: tenantScoped(store),
    controller: tenantScoped(
      new AmocrmController(prisma, store, loader, account.transport),
    ),
  };
}

async function tenant(
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' = 'ADMIN',
): Promise<{ tenantId: string; request: never }> {
  const t = await db.tenant.create({
    data: {
      slug: `amoc-${randomUUID()}`,
      name: 'amoCRM connect fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
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

const token = (): string => `tok-${randomBytes(12).toString('hex')}`;

describe('connecting amoCRM from the web (ADR 081)', () => {
  it('checks the account, stores the token encrypted, never returns or audits it, then chooses the pipeline', async () => {
    const account = new FakeAccount();
    const { controller, store } = setup(account);
    const t = await tenant();
    const secret = token();
    account.token = secret;
    const summary = await controller.connect(t.request, {
      subdomain: ' Example ',
      token: secret,
    });
    expect(summary).toMatchObject({
      connectorKey: 'amocrm',
      status: 'ACTIVE',
      configured: true,
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(account.calls.map((c) => c.path)).toEqual(['/api/v4/account']);
    expect(account.calls[0]?.host).toBe('example.amocrm.ru');

    const row = await db.tenantConnector.findUniqueOrThrow({
      where: { id: summary.id },
    });
    expect(row.config).toEqual({
      subdomain: 'example',
      tokenSecretRef: 'store:amocrm_token',
    });
    expect(
      (
        await store.read(
          { tenantId: t.tenantId, tenantConnectorId: row.id },
          'amocrm_token',
        )
      )?.value,
    ).toBe(secret);
    const sealed = await db.connectorSecret.findFirstOrThrow({
      where: { tenantId: t.tenantId },
    });
    expect(Buffer.from(sealed.ciphertext).toString('latin1')).not.toContain(
      secret,
    );
    expect(
      (
        await db.tenantConnector.findFirstOrThrow({
          where: { tenantId: t.tenantId, connectorKey: 'mock' },
        })
      ).config,
    ).toMatchObject({ createLead: false });
    const audit = await db.auditEvent.findMany({
      where: { tenantId: t.tenantId },
    });
    expect(audit.map((a) => a.action)).toEqual(['connector.amocrm_connected']);
    expect(JSON.stringify(audit)).not.toContain(secret);

    // Pipelines come from the account; the choice is saved in the config.
    const view = await controller.pipelines(t.request, summary.id);
    expect(view.pipelineId).toBeNull();
    expect(view.pipelines.map((p) => p.id)).toEqual([
      MAIN_PIPELINE_ID,
      SECOND_PIPELINE_ID,
    ]);
    await expect(
      controller.choosePipeline(t.request, summary.id, { pipelineId: 5 }),
    ).rejects.toMatchObject({ status: 400 });
    const chosen = await controller.choosePipeline(t.request, summary.id, {
      pipelineId: SECOND_PIPELINE_ID,
    });
    expect(chosen.pipelineId).toBe(SECOND_PIPELINE_ID);
    expect(
      (await db.tenantConnector.findUniqueOrThrow({ where: { id: row.id } }))
        .config,
    ).toMatchObject({ pipelineId: SECOND_PIPELINE_ID });

    // A reconnect of the same account keeps the choice.
    const next = token();
    account.token = next;
    await controller.connect(t.request, { subdomain: 'example', token: next });
    expect(
      (await db.tenantConnector.findUniqueOrThrow({ where: { id: row.id } }))
        .config,
    ).toMatchObject({ pipelineId: SECOND_PIPELINE_ID });
  });

  it('refuses bad input, a bad token, an unreachable and a blocked account; stores nothing; keeps the token out of logs', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation((...args) => {
        logged.push(args.map((a) => String(a)).join(' '));
      });
    const account = new FakeAccount();
    const { controller } = setup(account);
    const t = await tenant();
    const secret = token();
    const attempt = (body: unknown): Promise<unknown> =>
      controller.connect(t.request, body).catch((e: unknown) => e);
    const status = (e: unknown): number => (e as { status: number }).status;
    const code = (e: unknown): string =>
      (e as { getResponse(): { code: string } }).getResponse().code;

    for (const subdomain of ['evil.com', 'a/b', '', 'x.kommo.com'])
      expect(code(await attempt({ subdomain, token: secret }))).toBe(
        'INVALID_BODY',
      );
    expect(code(await attempt({ subdomain: 'example', token: 'short' }))).toBe(
      'INVALID_BODY',
    );
    // Wrong token: the account answers 401.
    expect(code(await attempt({ subdomain: 'example', token: secret }))).toBe(
      'TOKEN_INVALID',
    );
    account.token = secret;
    account.queue('/api/v4/account', { status: 500, body: { x: secret } });
    const unreachable = await attempt({ subdomain: 'example', token: secret });
    expect([status(unreachable), code(unreachable)]).toEqual([
      502,
      'CRM_UNREACHABLE',
    ]);
    account.queue('/api/v4/account', { status: 403, body: {} });
    expect(code(await attempt({ subdomain: 'example', token: secret }))).toBe(
      'CRM_REJECTED',
    );
    expect(
      await db.tenantConnector.count({
        where: { tenantId: t.tenantId, connectorKey: 'amocrm' },
      }),
    ).toBe(0);
    expect(
      await db.connectorSecret.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
    expect(logged.join('\n')).not.toContain(secret);
  });

  it('is for owners and admins only, and tenant scoped', async () => {
    const account = new FakeAccount();
    const { controller } = setup(account);
    const operator = await tenant('OPERATOR');
    await expect(
      controller.connect(operator.request, {
        subdomain: 'example',
        token: account.token,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const a = await tenant('OWNER');
    const b = await tenant('OWNER');
    const made = await controller.connect(a.request, {
      subdomain: 'example',
      token: account.token,
    });
    await expect(
      controller.pipelines(b.request, made.id),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('allows ten changes a minute per operator', async () => {
    const account = new FakeAccount();
    const { controller } = setup(account);
    const t = await tenant();
    for (let i = 0; i < 10; i++)
      await controller
        .connect(t.request, { subdomain: '-', token: 'x'.repeat(12) })
        .catch(() => undefined);
    await expect(
      controller.connect(t.request, { subdomain: '-', token: 'x'.repeat(12) }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
