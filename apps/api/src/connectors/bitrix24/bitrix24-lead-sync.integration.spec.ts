import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { LeadSyncService } from '../../leads/lead-sync.service.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { ConnectorRegistry } from '../registry/connector-registry.js';
import {
  bitrix24ConnectorRegistration,
  mockConnectorRegistration,
} from '../registry/registrations.js';
import { TenantConnectorLoader } from '../sync/tenant-connector-loader.js';
import { Bitrix24Connector } from './bitrix24-connector.js';
import { TEST_WEBHOOK_URL } from './testing/bitrix24-fixtures.js';
import { FakePortal } from './testing/fake-portal.js';

/**
 * The real LeadSyncService (ADR 023 operation records) with the real
 * Bitrix24 connector behind the real loader and registry; only the HTTP
 * transport is the fake portal (recorded response shapes, no network).
 * The tenant has the mock catalog with lead creation off plus bitrix24, so
 * this also covers the stopgap lead routing.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const database = process.env.TEST_POSTGRES_DATABASE ?? '';
if (
  !/^agentcore_[a-z0-9_]+$/u.test(database) ||
  database === process.env.POSTGRES_DATABASE
)
  throw new Error('requires a dedicated agentcore_* test database');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => db.$disconnect());

const PHONE = '+998900000017';
const SECRET_REF = 'env:CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL';

function syncWith(portal: FakePortal): LeadSyncService {
  const registry = new ConnectorRegistry({
    resolve: (ref): string | undefined =>
      ref === SECRET_REF ? TEST_WEBHOOK_URL : undefined,
  });
  registry.register(mockConnectorRegistration());
  const real = bitrix24ConnectorRegistration();
  registry.register({
    ...real,
    factory: (context, config, dependencies) =>
      new Bitrix24Connector(context, config, {
        resolveSecret: dependencies.resolveSecret,
        client: {
          transport: portal.transport,
          minIntervalMs: 0,
          sleep: async (): Promise<void> => undefined,
        },
      }),
  });
  return new LeadSyncService(
    prisma,
    new TenantConnectorLoader(prisma, registry),
  );
}

async function leadWorld(
  summary: string,
): Promise<{ tenantId: string; leadId: string }> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `b24-${suffix}`,
      name: 'Bitrix24 lead sync fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `b24-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Synthetic Customer',
      phone: PHONE,
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
    },
  });
  // Oldest first: without createLead:false the mock would take the lead.
  await db.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: 'mock',
      status: 'ACTIVE',
      config: { sourceSystem: 'mock-education', createLead: false },
    },
  });
  await db.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: 'bitrix24',
      status: 'ACTIVE',
      config: { webhookSecretRef: SECRET_REF },
    },
  });
  const lead = await db.lead.create({
    data: {
      tenantId: tenant.id,
      contactId: contact.id,
      conversationId: conversation.id,
      score: 'WARM',
      summary,
      requirements: {},
      idempotencyKey: `lead-${suffix}`,
      crmSyncStatus: 'PENDING',
    },
  });
  return { tenantId: tenant.id, leadId: lead.id };
}

describe('Bitrix24 lead sink through LeadSyncService (fake portal)', () => {
  it('creates once, skips a re-sync, and adds a duplicate as a comment', async () => {
    const portal = new FakePortal();
    const sync = syncWith(portal);

    const a = await leadWorld('Asked for the evening group (synthetic).');
    expect(await sync.sync(a.tenantId, a.leadId)).toBe('SYNCED');
    const leadA = await db.lead.findFirstOrThrow({ where: { id: a.leadId } });
    const [created] = portal.leads;
    expect(leadA).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: String(created?.id),
    });
    const opA = await db.connectorOperation.findFirstOrThrow({
      where: { tenantId: a.tenantId, subjectId: a.leadId },
    });
    expect(opA).toMatchObject({ status: 'SUCCEEDED', attemptMode: 'lookup' });
    expect(created?.fields).toMatchObject({
      title: 'Telegram: Synthetic Customer',
      sourceId: 'OTHER',
      originatorId: 'tezda',
    });
    expect(created?.fields.originId).toEqual(expect.any(String));
    expect(portal.comments).toEqual([
      { leadId: created?.id, text: expect.stringContaining('evening group') },
    ]);

    // Re-sync: the operation record says done, the portal is not called.
    const before = portal.calls.length;
    expect(await sync.sync(a.tenantId, a.leadId)).toBe('SKIPPED');
    expect(portal.calls.length).toBe(before);

    // Another conversation, same phone: a comment on that lead, no new lead.
    const b = await leadWorld('Came back about the weekend group (synthetic).');
    expect(await sync.sync(b.tenantId, b.leadId)).toBe('SYNCED');
    const leadB = await db.lead.findFirstOrThrow({ where: { id: b.leadId } });
    expect(leadB.crmLeadId).toBe(String(created?.id));
    expect(portal.callsOf('crm.item.add')).toHaveLength(1);
    expect(portal.comments.map((c) => c.leadId)).toEqual([
      created?.id,
      created?.id,
    ]);
    expect(portal.comments[1]?.text).toContain('weekend group');
  });
});
