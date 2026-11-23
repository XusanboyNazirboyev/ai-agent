/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConnectorSelector } from '../connectors/connector-selector.js';
import { createConnectorRegistry } from '../connectors/connectors.module.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { PrismaChannelSecretStore } from '../secrets/channel-secret-store.js';
import { ChannelsController } from './channels.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Go-live tests require agentcore_test');
const db = ownerClient();
const app = appClient() as unknown as PrismaService;
afterAll(async () => {
  await Promise.all([
    db.$disconnect(),
    (app as unknown as { $disconnect(): Promise<void> }).$disconnect(),
  ]);
});

const settings: Record<string, unknown> = {
  NODE_ENV: 'development',
  LLM_PROVIDER: 'mock',
  LLM_TRUSTED_PROVIDERS: ['mock'],
  LLM_ALLOW_REAL_CUSTOMER_DATA: false,
};
const registry = createConnectorRegistry({
  NODE_ENV: 'test',
  CONNECTOR_OUTBOUND_POLICY: 'strict',
});
const controller = tenantScoped(
  new ChannelsController(
    app,
    { get: (key: string) => settings[key] } as never,
    new PrismaChannelSecretStore(app, undefined),
    new ConnectorSelector(app, new TenantConnectorLoader(app, registry)),
  ),
);

async function world(options: { testAccount?: boolean } = {}) {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `golive-${id}`,
      name: 'Sayohat Tour',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn'],
      timezone: 'Asia/Tashkent',
      packKey: 'travel',
      packVersion: '1',
    },
  });
  const op = await db.operator.create({
    data: { tenantId: t.id, displayName: 'Owner', role: 'OWNER' },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `bot-${id}`,
      displayName: 'Bot',
      isTestAccount: options.testAccount ?? false,
    },
  });
  const as = {
    principal: {
      tenantId: t.id,
      operatorId: op.id,
      role: 'OWNER',
      sessionId: 's',
    },
  } as never;
  const live = () => controller.setMode(as, account.id, { mode: 'LIVE' });
  const refusal = async () => {
    try {
      await live();
      return undefined;
    } catch (error) {
      return (error as { response?: { code?: string; missing?: string[] } })
        .response;
    }
  };
  return { tenantId: t.id, as, accountId: account.id, live, refusal };
}

const mock = (tenantId: string) =>
  db.tenantConnector.create({
    data: {
      tenantId,
      connectorKey: 'mock',
      status: 'ACTIVE',
      config: { sourceSystem: 'mock-travel' } as never,
    },
  });
const phone = (tenantId: string) =>
  db.tenant.update({
    where: { id: tenantId },
    data: { config: { profile: { phone: '+998 90 123 45 67' } } },
  });

describe('go-live gate (owner 2026-11-23)', () => {
  it('keeps LIVE closed until a real catalog and the business phone are on file', async () => {
    const w = await world();
    expect(await w.refusal()).toMatchObject({
      code: 'SETUP_INCOMPLETE',
      missing: ['CATALOG', 'PROFILE'],
    });
    // Drafts only never reach a customer: not gated.
    await controller.setMode(w.as, w.accountId, { mode: 'SHADOW' });
    // The fictional demo catalog is not a catalog for real customers.
    await mock(w.tenantId);
    await phone(w.tenantId);
    expect(await w.refusal()).toMatchObject({ missing: ['CATALOG'] });
  });

  it('lets a test account go LIVE on the demo catalog once the profile is filled', async () => {
    const w = await world({ testAccount: true });
    await mock(w.tenantId);
    expect(await w.refusal()).toMatchObject({ missing: ['PROFILE'] });
    await phone(w.tenantId);
    expect((await w.live()).agentMode).toBe('LIVE');
    // An account already LIVE is not re-checked.
    await db.tenant.update({
      where: { id: w.tenantId },
      data: { config: {} },
    });
    expect((await w.live()).agentMode).toBe('LIVE');
  });
});
