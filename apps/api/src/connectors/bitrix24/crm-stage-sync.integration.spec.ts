import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDefaultPipeline } from '../../leads/lead-stage.util.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { PrivilegedDatabase } from '../../persistence/privileged-database.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../../persistence/testing/test-clients.js';
import { ConnectorRegistry } from '../registry/connector-registry.js';
import {
  bitrix24ConnectorRegistration,
  mockConnectorRegistration,
} from '../registry/registrations.js';
import { TenantConnectorLoader } from '../sync/tenant-connector-loader.js';
import { Bitrix24Connector } from './bitrix24-connector.js';
import {
  CrmStageSyncService,
  StageSyncRefusal,
} from './crm-stage-sync.service.js';
import { TEST_WEBHOOK_URL } from './testing/bitrix24-fixtures.js';
import { FakePortal } from './testing/fake-portal.js';

/**
 * ADR 079: the stage sync with the real service, loader and Bitrix24
 * connector; only the HTTP transport is the fake portal (docs shapes, not
 * yet checked on a live portal). Fixtures on the owner, the code under test
 * on the app role; the scan finds connectors on the privileged handle.
 */
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

const SECRET_REF = 'env:CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL';
const MIN = 60_000;

function serviceWith(portal: FakePortal): CrmStageSyncService {
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
          maxRateRetries: 0,
          sleep: async (): Promise<void> => undefined,
        },
      }),
  });
  return new CrmStageSyncService(
    prisma,
    new TenantConnectorLoader(prisma, registry),
    { db } as unknown as PrivilegedDatabase,
  );
}

interface World {
  tenantId: string;
  connectorId: string;
  operatorId: string;
  stages: Record<string, string>;
  newLead(externalId: string, options?: { archived?: boolean }): Promise<string>;
}

async function world(): Promise<World> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `b24s-${suffix}`,
      name: 'Stage sync fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const { pipelineId } = await db.$transaction((tx) =>
    ensureDefaultPipeline(tx, tenant.id),
  );
  const stageRows = await db.leadStage.findMany({
    where: { tenantId: tenant.id, pipelineId },
  });
  const stages = Object.fromEntries(
    stageRows.map((s) => [s.code ?? s.id, s.id]),
  );
  const operator = await db.operator.create({
    data: { tenantId: tenant.id, displayName: 'Admin', role: 'ADMIN' },
  });
  const connector = await db.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: 'bitrix24',
      status: 'ACTIVE',
      config: { webhookSecretRef: SECRET_REF },
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `b24s-${suffix}`,
      status: 'ACTIVE',
    },
  });
  return {
    tenantId: tenant.id,
    connectorId: connector.id,
    operatorId: operator.id,
    stages,
    async newLead(externalId, options = {}): Promise<string> {
      const id = randomUUID();
      const contact = await db.contact.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          providerUserId: `u-${id}`,
          name: 'Synthetic Customer',
        },
      });
      const conversation = await db.conversation.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          contactId: contact.id,
          providerChatId: `c-${id}`,
        },
      });
      const lead = await db.lead.create({
        data: {
          tenantId: tenant.id,
          contactId: contact.id,
          conversationId: conversation.id,
          pipelineId,
          pipelineStageId: stages.NEW,
          score: 'WARM',
          summary: 'Synthetic lead for the stage sync.',
          requirements: {},
          idempotencyKey: `lead-${id}`,
          crmSyncStatus: 'SYNCED',
          crmLeadId: externalId,
          ...(options.archived ? { archivedAt: new Date() } : {}),
        },
      });
      await db.connectorOperation.create({
        data: {
          tenantId: tenant.id,
          kind: 'createLead',
          subjectType: 'lead',
          subjectId: lead.id,
          idempotencyKey: `op-${id}`,
          status: 'SUCCEEDED',
          externalId,
        },
      });
      return lead.id;
    },
  };
}

/** Saves the default mapping of the fake portal's stages and switches on. */
async function enable(
  sync: CrmStageSyncService,
  w: World,
  extra: Record<string, string | null> = {},
): Promise<void> {
  const scoped = tenantScoped(sync, { tenantArg: 0 });
  const view = await scoped.view(w.tenantId, w.connectorId);
  await scoped.save(w.tenantId, w.connectorId, w.operatorId, {
    enabled: true,
    mappings: view.stages.map((s) => ({
      externalStageId: s.externalStageId,
      leadStageId:
        s.externalStageId in extra
          ? (extra[s.externalStageId] ?? null)
          : s.leadStageId,
    })),
  });
}

const stateOf = (leadId: string) =>
  db.lead.findFirstOrThrow({ where: { id: leadId } });
const movedAudits = (leadId: string) =>
  db.auditEvent.findMany({
    where: { entityId: leadId, action: 'lead.stage.moved' },
  });

describe('Bitrix24 stage sync (ADR 079, fake portal)', () => {
  it('shows defaults by semantics, saves a mapping and refuses foreign stages', async () => {
    const portal = new FakePortal();
    const sync = tenantScoped(serviceWith(portal), { tenantArg: 0 });
    const w = await world();
    const other = await world();

    const view = await sync.view(w.tenantId, w.connectorId);
    expect(view).toMatchObject({ enabled: false, portalReachable: true });
    const byId = Object.fromEntries(
      view.stages.map((s) => [s.externalStageId, s]),
    );
    expect(byId.NEW).toMatchObject({ leadStageId: null, saved: false });
    expect(byId.CONVERTED?.leadStageId).toBe(w.stages.WON);
    expect(byId.JUNK?.leadStageId).toBe(w.stages.LOST);
    // The method call is the read-only status dictionary.
    expect(portal.callsOf('crm.status.list')[0]?.params).toEqual({
      filter: { ENTITY_ID: 'STATUS' },
    });

    await expect(
      sync.save(w.tenantId, w.connectorId, w.operatorId, {
        enabled: true,
        mappings: [
          { externalStageId: 'NEW', leadStageId: other.stages.QUALIFIED! },
        ],
      }),
    ).rejects.toBeInstanceOf(StageSyncRefusal);
    await expect(
      sync.save(w.tenantId, w.connectorId, w.operatorId, {
        enabled: true,
        mappings: [{ externalStageId: 'NOPE', leadStageId: null }],
      }),
    ).rejects.toBeInstanceOf(StageSyncRefusal);

    const saved = await sync.save(w.tenantId, w.connectorId, w.operatorId, {
      enabled: true,
      mappings: [
        { externalStageId: 'IN_PROCESS', leadStageId: w.stages.QUALIFIED! },
        { externalStageId: 'NEW', leadStageId: null },
      ],
    });
    expect(saved.enabled).toBe(true);
    expect(
      saved.stages.find((s) => s.externalStageId === 'IN_PROCESS'),
    ).toMatchObject({ leadStageId: w.stages.QUALIFIED, saved: true });
    const row = await db.crmStageSync.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    expect(row.cursorAt).not.toBeNull();
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, action: 'connector.stage_sync_saved' },
    });
    expect(JSON.stringify(audit.safeInputSummary)).not.toMatch(/https?:|rest\//u);
    // Nothing of this tenant's mapping reached the other tenant.
    expect(
      await db.crmStageMapping.count({ where: { tenantId: other.tenantId } }),
    ).toBe(0);
  });

  it('moves leads on the portal changes: WON, LOST with reason; ignores the rest; never crosses tenants', async () => {
    const portal = new FakePortal();
    const service = serviceWith(portal);
    const w = await world();
    const other = await world();
    await enable(service, w, { IN_PROCESS: null });

    const won = await w.newLead('10');
    const lost = await w.newLead('11');
    const unmapped = await w.newLead('12');
    const archived = await w.newLead('13', { archived: true });
    // Same portal id, other tenant (sync off): must never be touched.
    const foreign = await other.newLead('10');
    for (let i = 0; i < 5; i++)
      portal.leads.push({ id: 10 + i, fields: { stageId: 'NEW' } });
    const at = (offsetMs: number): string =>
      new Date(Date.now() + offsetMs).toISOString();
    portal.moveLead(10, 'CONVERTED', at(1_000));
    portal.moveLead(11, 'JUNK', at(2_000));
    portal.moveLead(12, 'IN_PROCESS', at(3_000)); // mapped to "ignore"
    portal.moveLead(13, 'CONVERTED', at(4_000)); // archived on our side
    portal.moveLead(14, 'CONVERTED', at(5_000)); // we never created it

    const t0 = new Date();
    expect(await service.scanDue(t0, w.tenantId)).toBe(2);

    expect(await stateOf(won)).toMatchObject({
      status: 'WON',
      pipelineStageId: w.stages.WON,
      stageSetBy: 'OPERATOR',
    });
    expect(await stateOf(lost)).toMatchObject({
      status: 'LOST',
      pipelineStageId: w.stages.LOST,
      lostReason: 'Bitrix24: Junk lead',
      stageSetBy: 'OPERATOR',
    });
    expect((await stateOf(unmapped)).pipelineStageId).toBe(w.stages.NEW);
    expect((await stateOf(archived)).pipelineStageId).toBe(w.stages.NEW);
    expect((await stateOf(foreign)).pipelineStageId).toBe(other.stages.NEW);
    const [audit] = await movedAudits(lost);
    expect(audit?.safeInputSummary).toMatchObject({
      source: 'bitrix24',
      externalStageId: 'JUNK',
      to: w.stages.LOST,
    });
    expect(JSON.stringify(audit?.safeInputSummary)).not.toMatch(/https?:/u);

    // The cursor moved to the newest item, and the run is recorded.
    const row = await db.crmStageSync.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    expect(row.lastErrorCode).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(row.cursorAt?.getTime()).toBe(
      Date.parse(String(portal.leads[4]?.fields.updatedTime)),
    );
    expect(portal.callsOf('crm.item.list')).toHaveLength(1);
    expect(portal.callsOf('crm.item.list')[0]?.params).toMatchObject({
      entityTypeId: 1,
      select: ['id', 'stageId', 'updatedTime'],
    });

    // Within the interval: not polled. Later: polled again over the
    // overlap, and nothing moves twice.
    expect(await service.scanDue(new Date(t0.getTime() + MIN), w.tenantId)).toBe(0);
    expect(portal.callsOf('crm.item.list')).toHaveLength(1);
    expect(await service.scanDue(new Date(t0.getTime() + 3 * MIN), w.tenantId)).toBe(0);
    expect(portal.callsOf('crm.item.list')).toHaveLength(2);
    expect(await movedAudits(won)).toHaveLength(1);
    expect(await movedAudits(lost)).toHaveLength(1);

    // A manager moves it on in the portal: the lead follows.
    portal.moveLead(12, 'CONVERTED', at(60_000));
    expect(await service.scanDue(new Date(t0.getTime() + 6 * MIN), w.tenantId)).toBe(1);
    expect((await stateOf(unmapped)).status).toBe('WON');
  });

  it('does not poll a disabled connector, and two overlapping scans poll once', async () => {
    const portal = new FakePortal();
    const service = serviceWith(portal);
    const off = await world();
    await enable(service, off);
    await tenantScoped(service, { tenantArg: 0 }).save(
      off.tenantId,
      off.connectorId,
      off.operatorId,
      { enabled: false, mappings: [] },
    );
    expect(await service.scanDue(new Date(), off.tenantId)).toBe(0);
    expect(portal.callsOf('crm.item.list')).toHaveLength(0);

    const on = await world();
    await enable(service, on);
    const now = new Date();
    await Promise.all([
      service.scanDue(now, on.tenantId),
      service.scanDue(now, on.tenantId),
    ]);
    expect(portal.callsOf('crm.item.list')).toHaveLength(1);
  });

  it('records the error code of a failed run, keeps the cursor and does not stop others', async () => {
    const portal = new FakePortal();
    const service = serviceWith(portal);
    const bad = await world();
    await enable(service, bad);
    const before = await db.crmStageSync.findFirstOrThrow({
      where: { tenantId: bad.tenantId },
    });
    portal.queue('crm.item.list', {
      status: 401,
      body: { error: 'NO_AUTH_FOUND' },
    });
    await service.scanDue(new Date(), bad.tenantId);
    const after = await db.crmStageSync.findFirstOrThrow({
      where: { tenantId: bad.tenantId },
    });
    expect(after.lastErrorCode).toBe('BITRIX24_NO_AUTH_FOUND');
    expect(after.cursorAt).toEqual(before.cursorAt);
    expect(after.leaseUntil).toBeNull();
    expect(after.lastRunAt).not.toBeNull();
  });
});
