import type { ConfigService } from '@nestjs/config';
import { MockConnectorConfigSchema } from '@agentcore/shared';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../../config/environment.js';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { MockConnector } from '../mock/mock-connector.js';
import type { MockItemFixture } from '../mock/mock-fixtures.js';
import { ConnectorRegistry } from '../registry/connector-registry.js';
import {
  genericRestConnectorRegistration,
  MOCK_CONNECTOR_KEY,
} from '../registry/registrations.js';
import { nullSecretResolver } from '../interfaces/secret-resolver.js';
import { OutboundUrlPolicy } from '../generic-rest/ssrf-protection.js';
import { CatalogSyncQueueRuntime, shouldRetry } from './catalog-sync.queue.js';
import { CatalogSyncService } from './catalog-sync.service.js';
import {
  CatalogSyncRunLostError,
  CatalogSyncStore,
} from './catalog-sync.store.js';
import { TenantConnectorLoader } from './tenant-connector-loader.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Catalog sync integration tests require agentcore_test');
}

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const database = prisma as unknown as PrismaService;

/** Mutable, fictional upstream catalog shared by the mock connector. */
let upstream: MockItemFixture[] = [];

const registry = new ConnectorRegistry(nullSecretResolver);
registry.register({
  key: MOCK_CONNECTOR_KEY,
  capabilities: {
    sync: true,
    search: true,
    liveQuote: true,
    availability: true,
    createLead: true,
    updateLead: true,
    createBooking: true,
    webhooks: true,
  },
  factory: (context, config) => {
    const parsed = MockConnectorConfigSchema.parse(config);
    // A getter keeps the fixture list live across cached instances.
    const connector = new MockConnector(context, { ...parsed, items: [] });
    Object.defineProperty(connector, 'items', { get: () => upstream });
    return connector;
  },
});
registry.register(
  genericRestConnectorRegistration({
    outboundUrlPolicy: OutboundUrlPolicy.STRICT,
  }),
);

function config(
  values: Record<string, unknown>,
): ConfigService<AppEnvironment, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    AppEnvironment,
    true
  >;
}

const environment = config({
  CATALOG_SYNC_STALE_AFTER_SECONDS: 300,
  CATALOG_SYNC_MAX_ITEMS: 1_000,
  CATALOG_SYNC_INTERVAL_MINUTES: 0,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
});
const store = new CatalogSyncStore(database);
const loader = new TenantConnectorLoader(database, registry);
const service = new CatalogSyncService(store, loader, environment);

function items(count: number): MockItemFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceEntityId: `item-${index}`,
    itemType: 'course',
    title: `Fictional Course ${index}`,
    attributes: { level: 'B1' },
    offers: [
      {
        sourceEntityId: `offer-${index}`,
        price: { amount: '150.50', currency: 'USD' },
        pricingBasis: 'PER_PERSON',
        availabilityStatus: 'AVAILABLE',
        seatsLeft: 5,
        attributes: {},
      },
    ],
  }));
}

async function tenantWithConnector(
  overrides: Partial<Prisma.TenantConnectorUncheckedCreateInput> = {},
): Promise<{ tenantId: string; tenantConnectorId: string }> {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `sync-${randomUUID()}`,
      name: 'Catalog sync fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey: 'integration-test',
      packVersion: '1',
    },
  });
  const connector = await prisma.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: MOCK_CONNECTOR_KEY,
      status: 'ACTIVE',
      config: { sourceSystem: 'mock-sync' },
      ...overrides,
    },
  });
  return { tenantId: tenant.id, tenantConnectorId: connector.id };
}

async function catalog(
  tenantId: string,
): Promise<Array<{ sourceEntityId: string; status: string }>> {
  return prisma.catalogItem.findMany({
    where: { tenantId },
    select: { sourceEntityId: true, status: true },
    orderBy: { sourceEntityId: 'asc' },
  });
}

beforeEach(() => {
  upstream = items(10);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('catalog sync persistence', () => {
  it('imports a snapshot transactionally with run status and counts', async () => {
    const fixture = await tenantWithConnector();
    const result = await service.run(fixture);
    expect(result).toMatchObject({ outcome: 'SUCCEEDED', itemsUpserted: 10 });

    const stored = await prisma.catalogItem.findMany({
      where: { tenantId: fixture.tenantId },
      include: { offers: true },
    });
    expect(stored).toHaveLength(10);
    const first = stored.find((item) => item.sourceEntityId === 'item-0')!;
    expect(first).toMatchObject({
      sourceSystem: 'mock-sync',
      itemType: 'course',
      status: 'ACTIVE',
      normalizedTitle: 'fictional course 0',
      attributes: { fields: { level: 'B1' } },
    });
    expect(first.offers[0].price?.toString()).toBe('150.5');
    expect(first.offers[0].currency).toBe('USD');

    const run = await prisma.catalogSyncRun.findFirstOrThrow({
      where: { tenantId: fixture.tenantId },
    });
    expect(run).toMatchObject({
      status: 'SUCCEEDED',
      sourceSystem: 'mock-sync',
      itemsSeen: 10,
      itemsUpserted: 10,
      offersUpserted: 10,
      errorCode: null,
    });
    expect(run.finishedAt).not.toBeNull();
  });

  it('is idempotent: an unchanged catalog writes nothing new', async () => {
    const fixture = await tenantWithConnector();
    await service.run(fixture);
    const before = await prisma.catalogItem.findMany({
      where: { tenantId: fixture.tenantId },
      select: { id: true, sourceHash: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });

    await expect(service.run(fixture)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      itemsUpserted: 0,
    });
    const after = await prisma.catalogItem.findMany({
      where: { tenantId: fixture.tenantId },
      select: { id: true, sourceHash: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(
      before.map(({ id, sourceHash }) => ({ id, sourceHash })),
    );
    const runs = await store.listRuns(
      fixture.tenantId,
      fixture.tenantConnectorId,
    );
    expect(runs[0]).toMatchObject({ itemsUnchanged: 10, offersUnchanged: 10 });
  });

  it('deactivates (never deletes) a removed record and reactivates it', async () => {
    const fixture = await tenantWithConnector();
    await service.run(fixture);
    upstream = upstream.slice(1);

    await expect(service.run(fixture)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      itemsDeactivated: 1,
    });
    const rows = await catalog(fixture.tenantId);
    expect(rows).toHaveLength(10);
    expect(rows.find((row) => row.sourceEntityId === 'item-0')?.status).toBe(
      'INACTIVE',
    );
    const offer = await prisma.offer.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, sourceEntityId: 'offer-0' },
    });
    expect(offer.deletedAt).not.toBeNull();

    upstream = items(10);
    await service.run(fixture);
    expect(
      (await catalog(fixture.tenantId)).every((row) => row.status === 'ACTIVE'),
    ).toBe(true);
  });

  it('blocks a run that would wipe the catalog and leaves it untouched', async () => {
    const fixture = await tenantWithConnector();
    await service.run(fixture);
    upstream = [];

    await expect(service.run(fixture)).resolves.toMatchObject({
      outcome: 'BLOCKED',
      errorCode: 'CATALOG_SYNC_MASS_DEACTIVATION',
      retryable: false,
    });
    expect(
      (await catalog(fixture.tenantId)).every((row) => row.status === 'ACTIVE'),
    ).toBe(true);

    await expect(
      service.run({ ...fixture, allowMassDeactivation: true }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED', itemsDeactivated: 10 });
    expect(
      (await catalog(fixture.tenantId)).every(
        (row) => row.status === 'INACTIVE',
      ),
    ).toBe(true);
  });

  it('records a transient CRM outage as a retryable failure without writes', async () => {
    const fixture = await tenantWithConnector({
      config: { sourceSystem: 'mock-sync', failureMode: 'transient' },
    });
    const result = await service.run(fixture);
    expect(result).toMatchObject({
      outcome: 'FAILED',
      errorCode: 'CONNECTOR_UNAVAILABLE',
      retryable: true,
    });
    expect(shouldRetry(result)).toBe('CONNECTOR_UNAVAILABLE');
    expect(await catalog(fixture.tenantId)).toEqual([]);
    const [run] = await store.listRuns(
      fixture.tenantId,
      fixture.tenantConnectorId,
    );
    expect(run).toMatchObject({
      status: 'FAILED',
      errorCode: 'CONNECTOR_UNAVAILABLE',
    });
  });

  it('rejects the whole snapshot when one record cannot be stored', async () => {
    const fixture = await tenantWithConnector();
    upstream[3] = {
      ...upstream[3],
      offers: [
        {
          sourceEntityId: 'offer-bad',
          startsAt: '2026-11-10T10:00:00+05:00',
          endsAt: '2026-11-01T10:00:00+05:00',
          attributes: {},
        },
      ],
    };
    await expect(service.run(fixture)).resolves.toMatchObject({
      outcome: 'FAILED',
      errorCode: 'CATALOG_SYNC_INVALID_RECORD',
      retryable: false,
    });
    expect(await catalog(fixture.tenantId)).toEqual([]);
  });

  it('rejects prices the column would silently round', async () => {
    const fixture = await tenantWithConnector();
    upstream[0].offers = [
      {
        sourceEntityId: 'offer-precise',
        price: { amount: '10.1234567', currency: 'USD' },
        attributes: {},
      },
    ];
    await expect(service.run(fixture)).resolves.toMatchObject({
      errorCode: 'CATALOG_SYNC_INVALID_RECORD',
    });
  });

  it('keeps tenants isolated even with the same source system', async () => {
    const tenantA = await tenantWithConnector();
    const tenantB = await tenantWithConnector();
    await service.run(tenantA);
    await service.run(tenantB);
    upstream = upstream.slice(1);
    await service.run(tenantA);

    expect(
      (await catalog(tenantA.tenantId)).find(
        (row) => row.sourceEntityId === 'item-0',
      )?.status,
    ).toBe('INACTIVE');
    expect(
      (await catalog(tenantB.tenantId)).every((row) => row.status === 'ACTIVE'),
    ).toBe(true);
  });
});

describe('catalog sync run lifecycle', () => {
  it('lets the database reject a second running run per connector', async () => {
    const fixture = await tenantWithConnector();
    const staleBefore = new Date(Date.now() - 300_000);
    const first = await store.claimRun(
      fixture.tenantId,
      fixture.tenantConnectorId,
      {
        staleBefore,
      },
    );
    expect(first).toBeDefined();
    await expect(
      store.claimRun(fixture.tenantId, fixture.tenantConnectorId, {
        staleBefore,
      }),
    ).resolves.toBeUndefined();
    await expect(service.run(fixture)).resolves.toEqual({
      outcome: 'SKIPPED',
      reason: 'RUN_IN_PROGRESS',
    });
    expect(shouldRetry({ outcome: 'SKIPPED', reason: 'RUN_IN_PROGRESS' })).toBe(
      'RUN_IN_PROGRESS',
    );
  });

  it('recovers a stale run left by a crashed worker, then syncs', async () => {
    const fixture = await tenantWithConnector();
    const crashed = await prisma.catalogSyncRun.create({
      data: {
        ...fixture,
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 900_000),
        heartbeatAt: new Date(Date.now() - 600_000),
      },
    });

    await expect(service.run(fixture)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
    });
    await expect(
      prisma.catalogSyncRun.findUniqueOrThrow({ where: { id: crashed.id } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'CATALOG_SYNC_STALE',
    });
  });

  it('refuses to apply a plan after its run was recovered elsewhere', async () => {
    const fixture = await tenantWithConnector();
    const run = (await store.claimRun(
      fixture.tenantId,
      fixture.tenantConnectorId,
      {
        staleBefore: new Date(0),
      },
    ))!;
    await store.recoverStaleRuns(new Date(Date.now() + 1_000), {
      tenantId: fixture.tenantId,
    });
    await expect(
      store.applyPlan({
        tenantId: fixture.tenantId,
        runId: run.id,
        sourceSystem: 'mock-sync',
        plan: {
          itemUpserts: [
            {
              item: {
                id: 'mock-sync:x',
                sourceSystem: 'mock-sync',
                sourceEntityId: 'x',
                itemType: 'course',
                title: 'Fictional',
                attributes: {},
              },
              sourceHash: 'hash',
            },
          ],
          unchangedItems: [],
          itemDeactivations: [],
          offerUpserts: [],
          unchangedOffers: [],
          offerDeactivations: [],
        },
        counts: {
          itemsSeen: 1,
          itemsUpserted: 1,
          itemsUnchanged: 0,
          itemsDeactivated: 0,
          offersSeen: 0,
          offersUpserted: 0,
          offersUnchanged: 0,
          offersDeactivated: 0,
        },
      }),
    ).rejects.toBeInstanceOf(CatalogSyncRunLostError);
    expect(await catalog(fixture.tenantId)).toEqual([]);
  });

  it('skips inactive connectors without creating a run', async () => {
    const fixture = await tenantWithConnector({ status: 'DISABLED' });
    await expect(service.run(fixture)).resolves.toEqual({
      outcome: 'SKIPPED',
      reason: 'CONNECTOR_INACTIVE',
    });
    expect(
      await prisma.catalogSyncRun.count({
        where: { tenantId: fixture.tenantId },
      }),
    ).toBe(0);
  });

  it.each([
    [{ config: { sourceSystem: 'Not Valid' } }, 'CONNECTOR_INVALID_CONFIG'],
    [
      { config: { sourceSystem: 'mock-sync', apiToken: 'x' } },
      'CONNECTOR_INVALID_CONFIG',
    ],
    [
      { secretRef: 'env:CONNECTOR_SECRET_X' },
      'CONNECTOR_SECRET_REF_UNSUPPORTED',
    ],
    [{ capabilities: ['sync'] }, 'CONNECTOR_CAPABILITY_MISMATCH'],
  ])(
    'records configuration problems as failed runs: %o',
    async (overrides, code) => {
      const fixture = await tenantWithConnector(overrides);
      await expect(service.run(fixture)).resolves.toMatchObject({
        outcome: 'FAILED',
        errorCode: code,
        retryable: false,
      });
    },
  );

  it('refuses two connectors of a tenant syncing the same source system', async () => {
    const fixture = await tenantWithConnector({
      config: { sourceSystem: 'generic-rest' },
    });
    await service.run(fixture);
    const rest = await prisma.tenantConnector.create({
      data: {
        tenantId: fixture.tenantId,
        connectorKey: 'generic-rest',
        status: 'ACTIVE',
        config: {
          baseUrl: 'https://crm.example.invalid/api',
          endpoints: { listItems: { path: '/items' } },
        },
      },
    });
    await expect(
      service.run({ tenantId: fixture.tenantId, tenantConnectorId: rest.id }),
    ).resolves.toMatchObject({
      outcome: 'FAILED',
      errorCode: 'CATALOG_SYNC_SOURCE_CONFLICT',
    });
  });

  it('enforces run invariants in the database', async () => {
    const fixture = await tenantWithConnector();
    await expect(
      prisma.catalogSyncRun.create({
        data: { ...fixture, status: 'FAILED', finishedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.catalogSyncRun.create({
        data: { ...fixture, status: 'SUCCEEDED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.catalogSyncRun.create({
        data: { ...fixture, status: 'RUNNING', itemsSeen: -1 },
      }),
    ).rejects.toThrow();
  });
});

describe('catalog sync queue', () => {
  it('processes an enqueued sync through BullMQ and Redis', async () => {
    const fixture = await tenantWithConnector();
    const runtime = new CatalogSyncQueueRuntime(
      environment,
      service,
      store,
      loader,
    );
    runtime.onModuleInit();
    try {
      await runtime.enqueue(fixture);
      const deadline = Date.now() + 15_000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        const [run] = await store.listRuns(
          fixture.tenantId,
          fixture.tenantConnectorId,
        );
        status = run?.status;
        if (status === 'SUCCEEDED') break;
        await new Promise((done) => setTimeout(done, 100));
      }
      expect(status).toBe('SUCCEEDED');
      expect(await catalog(fixture.tenantId)).toHaveLength(10);
    } finally {
      await runtime.onModuleDestroy();
    }
  });

  it('schedules only active connectors that can sync and sweeps stale runs', async () => {
    const fixture = await tenantWithConnector();
    const stale = await prisma.catalogSyncRun.create({
      data: {
        ...fixture,
        status: 'RUNNING',
        heartbeatAt: new Date(Date.now() - 600_000),
      },
    });
    const enqueued: unknown[] = [];
    const runtime = new CatalogSyncQueueRuntime(
      environment,
      service,
      store,
      loader,
    );
    runtime.enqueue = async (request): Promise<void> => {
      enqueued.push(request);
    };
    await runtime.schedule();
    expect(enqueued).toContainEqual(fixture);
    await expect(
      prisma.catalogSyncRun.findUniqueOrThrow({ where: { id: stale.id } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'CATALOG_SYNC_STALE',
    });
  });
});
