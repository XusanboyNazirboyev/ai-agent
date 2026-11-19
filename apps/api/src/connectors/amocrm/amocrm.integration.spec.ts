import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { LeadSyncService } from '../../leads/lead-sync.service.js';
import { ensureDefaultPipeline } from '../../leads/lead-stage.util.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { PrivilegedDatabase } from '../../persistence/privileged-database.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../../persistence/testing/test-clients.js';
import { CrmStageSyncService } from '../bitrix24/crm-stage-sync.service.js';
import { ConnectorRegistry } from '../registry/connector-registry.js';
import {
  amocrmConnectorRegistration,
  mockConnectorRegistration,
} from '../registry/registrations.js';
import { TenantConnectorLoader } from '../sync/tenant-connector-loader.js';
import { AmocrmConnector } from './amocrm-connector.js';
import {
  MAIN_PIPELINE_ID,
  SECOND_PIPELINE_ID,
  TEST_SUBDOMAIN,
  TEST_TOKEN,
} from './testing/amocrm-fixtures.js';
import { FakeAccount } from './testing/fake-account.js';

/**
 * ADR 081: amoCRM lead sync and stage sync with the real services, loader and
 * connector; only the HTTP transport is the fake account (official doc
 * shapes; not checked on a live account). Fixtures on the owner, the code
 * under test on the app role.
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

const SECRET_REF = 'env:CONNECTOR_SECRET_AMOCRM_TOKEN';
const MIN = 60_000;

function registryWith(account: FakeAccount): TenantConnectorLoader {
  const registry = new ConnectorRegistry({
    resolve: (ref): string | undefined =>
      ref === SECRET_REF ? TEST_TOKEN : undefined,
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
  return new TenantConnectorLoader(prisma, registry);
}

function serviceWith(account: FakeAccount): CrmStageSyncService {
  return new CrmStageSyncService(prisma, registryWith(account), {
    db,
  } as unknown as PrivilegedDatabase);
}

interface World {
  tenantId: string;
  connectorId: string;
  operatorId: string;
  stages: Record<string, string>;
  newLead(
    externalId: string,
    options?: { archived?: boolean; pending?: boolean },
  ): Promise<string>;
}

async function world(): Promise<World> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `amo-${suffix}`,
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
      connectorKey: 'amocrm',
      status: 'ACTIVE',
      config: {
        subdomain: TEST_SUBDOMAIN,
        tokenSecretRef: SECRET_REF,
        pipelineId: MAIN_PIPELINE_ID,
      },
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `amo-${suffix}`,
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
          crmSyncStatus: options.pending ? 'PENDING' : 'SYNCED',
          ...(options.pending ? {} : { crmLeadId: externalId }),
          ...(options.archived ? { archivedAt: new Date() } : {}),
        },
      });
      if (!options.pending)
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

const stateOf = (
  leadId: string,
): Promise<{
  status: string;
  pipelineStageId: string | null;
  lostReason: string | null;
}> => db.lead.findFirstOrThrow({ where: { id: leadId } });

async function enable(sync: CrmStageSyncService, w: World): Promise<void> {
  const scoped = tenantScoped(sync, { tenantArg: 0 });
  const view = await scoped.view(w.tenantId, w.connectorId);
  await scoped.save(w.tenantId, w.connectorId, w.operatorId, {
    enabled: true,
    mappings: view.stages.map((s) => ({
      externalStageId: s.externalStageId,
      leadStageId: s.leadStageId,
    })),
  });
}

describe('amoCRM stage sync (ADR 081, fake account)', () => {
  it('shows only the chosen pipeline with 142/143 defaults', async () => {
    const account = new FakeAccount();
    const sync = tenantScoped(serviceWith(account), { tenantArg: 0 });
    const w = await world();
    const view = await sync.view(w.tenantId, w.connectorId);
    const byId = Object.fromEntries(
      view.stages.map((s) => [s.externalStageId, s]),
    );
    expect(view.stages.map((s) => s.externalStageId)).toEqual([
      '32392159',
      '32392165',
      '142',
      '143',
    ]);
    expect(byId['142']?.leadStageId).toBe(w.stages.WON);
    expect(byId['143']?.leadStageId).toBe(w.stages.LOST);
    expect(byId['32392165']).toMatchObject({ leadStageId: null, saved: false });
  });

  it('moves leads: WON, LOST with reason; ignores unmapped, unknown, archived, other tenant; polls only the chosen pipeline', async () => {
    const account = new FakeAccount();
    const service = serviceWith(account);
    const w = await world();
    const other = await world();
    await enable(service, w);

    const won = await w.newLead('101');
    const lost = await w.newLead('102');
    const unmapped = await w.newLead('103');
    const archived = await w.newLead('104', { archived: true });
    const elsewhere = await w.newLead('106');
    const foreign = await other.newLead('101');
    const now = Math.floor(Date.now() / 1000);
    const seed = (id: number, pipelineId: number, at: number): void => {
      account.leads.push({
        id,
        statusId: 32392159,
        pipelineId,
        updatedAt: at,
        isDeleted: false,
        body: {},
      });
    };
    for (const id of [101, 102, 103, 104, 105]) seed(id, MAIN_PIPELINE_ID, now);
    seed(106, SECOND_PIPELINE_ID, now);
    account.moveLead(101, 142, now + 1);
    account.moveLead(102, 143, now + 2);
    account.moveLead(103, 32392165, now + 3); // unmapped
    account.moveLead(104, 142, now + 4); // archived on our side
    account.moveLead(105, 142, now + 5); // we never created it
    account.moveLead(106, 142, now + 6); // other pipeline: not polled

    const t0 = new Date();
    expect(await service.scanDue(t0, w.tenantId)).toBe(2);
    expect(await stateOf(won)).toMatchObject({
      status: 'WON',
      pipelineStageId: w.stages.WON,
    });
    expect(await stateOf(lost)).toMatchObject({
      status: 'LOST',
      pipelineStageId: w.stages.LOST,
      lostReason: 'amoCRM: Закрыто и не реализовано',
    });
    for (const [id, stage] of [
      [unmapped, w.stages.NEW],
      [archived, w.stages.NEW],
      [elsewhere, w.stages.NEW],
    ] as const)
      expect((await stateOf(id)).pipelineStageId).toBe(stage);
    expect((await stateOf(foreign)).pipelineStageId).toBe(other.stages.NEW);

    const list = account.callsTo('/api/v4/leads')[0]?.query;
    expect(list).toMatchObject({
      'filter[pipeline_id][0]': String(MAIN_PIPELINE_ID),
      'order[updated_at]': 'asc',
      limit: '250',
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityId: lost, action: 'lead.stage.moved' },
    });
    expect(audit.safeInputSummary).toMatchObject({
      source: 'amocrm',
      externalStageId: '143',
    });
    const row = await db.crmStageSync.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    expect(row.lastErrorCode).toBeNull();
    // Newest processed lead of the chosen pipeline.
    expect(row.cursorAt?.getTime()).toBe((now + 5) * 1000);

    // Within the interval nothing is polled; later nothing moves twice.
    expect(
      await service.scanDue(new Date(t0.getTime() + MIN), w.tenantId),
    ).toBe(0);
    expect(account.callsTo('/api/v4/leads')).toHaveLength(1);
    expect(
      await service.scanDue(new Date(t0.getTime() + 3 * MIN), w.tenantId),
    ).toBe(0);
    expect(account.callsTo('/api/v4/leads')).toHaveLength(2);
  });

  it('records a 403 block, keeps the cursor', async () => {
    const account = new FakeAccount();
    const service = serviceWith(account);
    const bad = await world();
    await enable(service, bad);
    const before = await db.crmStageSync.findFirstOrThrow({
      where: { tenantId: bad.tenantId },
    });
    account.queue('/api/v4/leads', { status: 403, body: {} });
    await service.scanDue(new Date(), bad.tenantId);
    const after = await db.crmStageSync.findFirstOrThrow({
      where: { tenantId: bad.tenantId },
    });
    expect(after.lastErrorCode).toBe('AMOCRM_FORBIDDEN');
    expect(after.cursorAt).toEqual(before.cursorAt);
  });
});

describe('amoCRM lead sink through LeadSyncService (fake account)', () => {
  it('creates once through leads/complex and skips a re-sync', async () => {
    const account = new FakeAccount();
    const sync = tenantScoped(
      new LeadSyncService(prisma, registryWith(account)),
      { tenantArg: 0 },
    );
    const w = await world();
    const leadId = await w.newLead('x', { pending: true });
    expect(await sync.sync(w.tenantId, leadId)).toBe('SYNCED');
    const [created] = account.leads;
    expect(created?.body).toMatchObject({
      name: 'Telegram: Synthetic Customer',
      pipeline_id: MAIN_PIPELINE_ID,
      status_id: 32392159,
    });
    const lead = await db.lead.findFirstOrThrow({ where: { id: leadId } });
    expect(lead).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: String(created?.id),
    });
    const op = await db.connectorOperation.findFirstOrThrow({
      where: { tenantId: w.tenantId, subjectId: leadId },
    });
    expect(op).toMatchObject({
      status: 'SUCCEEDED',
      externalId: String(created?.id),
    });
    const calls = account.calls.length;
    expect(await sync.sync(w.tenantId, leadId)).toBe('SKIPPED');
    expect(account.calls.length).toBe(calls);
  });
});
