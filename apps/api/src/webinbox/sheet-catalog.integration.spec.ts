/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConnectorSelector } from '../connectors/connector-selector.js';
import { createConnectorRegistry } from '../connectors/connectors.module.js';
import { PrismaSheetCatalogStore } from '../connectors/spreadsheet/sheet-catalog.store.js';
import { SheetCatalogService } from '../connectors/spreadsheet/sheet-catalog.service.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { SheetCatalogController } from './sheet-catalog.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Sheet catalog API tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const store = new PrismaSheetCatalogStore(prisma);
const controller = new SheetCatalogController(
  new SheetCatalogService(prisma, store),
);
const registry = createConnectorRegistry(
  { NODE_ENV: 'test', CONNECTOR_OUTBOUND_POLICY: 'strict' },
  undefined,
  store,
);
const selector = new ConnectorSelector(
  prisma,
  new TenantConnectorLoader(prisma, registry),
);

const SAMPLE = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../docs/samples/tourism-price-list.sample.csv',
  ),
  'utf8',
);

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];

async function world() {
  const t = await db.tenant.create({
    data: {
      slug: `sheetapi-${randomUUID()}`,
      name: 'Sheet API fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'travel',
      packVersion: '1',
    },
  });
  const as = {} as Record<Role, never>;
  for (const role of ROLES) {
    const op = await db.operator.create({
      data: { tenantId: t.id, displayName: role, role },
    });
    as[role] = {
      principal: {
        tenantId: t.id,
        operatorId: op.id,
        role,
        sessionId: randomUUID(),
      },
    } as never;
  }
  return { tenantId: t.id, as };
}

const call = async (work: () => unknown) => {
  try {
    await work();
    return { status: 200, code: undefined as unknown };
  } catch (error) {
    const e = error as {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    };
    return { status: e.getStatus(), code: e.getResponse().code };
  }
};

describe('price list upload API (ADR 064)', () => {
  it('previews without saving, then saves, binds the catalog and lets the agent quote', async () => {
    const w = await world();
    const preview = controller.preview(w.as.ADMIN, SAMPLE);
    expect(preview).toMatchObject({
      rowCount: 15,
      accepted: 12,
      rejected: 3,
      missingFields: [],
    });
    expect(preview.errors.map((e) => e.code)).toEqual([
      'PRICE_INVALID',
      'DATE_INVALID',
      'CURRENCY_UNKNOWN',
    ]);
    expect(preview.sample).toHaveLength(10);
    expect(preview.mapping.price).toBe(9);
    expect(await controller.status(w.as.ADMIN)).toEqual({ uploaded: false });
    expect(
      await db.sheetCatalog.count({ where: { tenantId: w.tenantId } }),
    ).toBe(0);

    const done = await controller.upload(
      w.as.OWNER,
      SAMPLE,
      undefined,
      'tours.csv',
    );
    expect(done).toMatchObject({
      accepted: 12,
      rejected: 3,
      catalogBound: true,
      boundTo: 'spreadsheet',
    });
    const status = await controller.status(w.as.ADMIN);
    expect(status).toMatchObject({
      uploaded: true,
      sourceFilename: 'tours.csv',
      freshnessDays: 3,
      acceptedCount: 12,
      stale: false,
    });

    // The CATALOG role now serves this price list to the agent.
    const connector = await selector.select(w.tenantId, 'CATALOG', 'search');
    expect(connector?.connectorKey).toBe('spreadsheet');
    const items = await connector!.searchItems!({ title: 'rixos' });
    const offers = await connector!.getOffers!(items[0]!.id);
    const quote = await connector!.getQuote!(offers[0]!.id, {
      offerId: offers[0]!.id,
    });
    expect(quote.amount).toEqual({ amount: '820', currency: 'USD' });

    // Counts only in the audit trail.
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, action: 'catalog.sheet.uploaded' },
    });
    expect(audit.safeInputSummary).toMatchObject({
      rows: 15,
      accepted: 12,
      rejected: 3,
    });
    const dump = JSON.stringify(audit);
    for (const secret of ['Rixos', 'Dubai', '820', 'Atlantis'])
      expect(dump).not.toContain(secret);
  });

  it('never replaces an existing catalog binding', async () => {
    const w = await world();
    const mock = await db.tenantConnector.create({
      data: {
        tenantId: w.tenantId,
        connectorKey: 'mock',
        status: 'ACTIVE',
        config: { sourceSystem: 'mock-education' },
      },
    });
    await db.tenantConnectorRole.create({
      data: {
        tenantId: w.tenantId,
        role: 'CATALOG',
        tenantConnectorId: mock.id,
      },
    });
    const done = await controller.upload(w.as.ADMIN, SAMPLE);
    expect(done).toMatchObject({ catalogBound: false, boundTo: 'mock' });
    const role = await db.tenantConnectorRole.findFirstOrThrow({
      where: { tenantId: w.tenantId, role: 'CATALOG' },
    });
    expect(role.tenantConnectorId).toBe(mock.id);
  });

  it('lets only an owner or admin use it', async () => {
    const w = await world();
    for (const role of ['OPERATOR', 'VIEWER'] as Role[]) {
      expect((await call(() => controller.status(w.as[role]))).status).toBe(
        403,
      );
      expect(
        (await call(() => controller.preview(w.as[role], SAMPLE))).status,
      ).toBe(403);
      expect(
        (await call(() => controller.upload(w.as[role], SAMPLE))).status,
      ).toBe(403);
    }
    expect(
      await db.sheetCatalog.count({ where: { tenantId: w.tenantId } }),
    ).toBe(0);
  });

  it('refuses bad input with a clear code and saves nothing', async () => {
    const w = await world();
    const upload = (body: unknown, config?: string) =>
      call(() => controller.upload(w.as.ADMIN, body, config));
    expect(await upload('')).toEqual({ status: 400, code: 'INVALID_BODY' });
    expect(await upload({ csv: 'x' })).toEqual({
      status: 400,
      code: 'INVALID_BODY',
    });
    expect(await upload(SAMPLE, 'not json')).toEqual({
      status: 400,
      code: 'INVALID_QUERY',
    });
    expect(await upload(SAMPLE, '{"unknown":1}')).toEqual({
      status: 400,
      code: 'INVALID_QUERY',
    });
    expect(await upload(SAMPLE, '{"mapping":{"price":40}}')).toEqual({
      status: 400,
      code: 'SHEET_COLUMN_OUT_OF_RANGE',
    });
    expect(await upload('Hotel,Nights\nA,3')).toEqual({
      status: 400,
      code: 'SHEET_MAPPING_INCOMPLETE',
    });
    expect(await upload('Hotel,Price,Currency\nA,abc,USD')).toEqual({
      status: 400,
      code: 'SHEET_NO_VALID_ROWS',
    });
    expect(await upload('a,b\n"open,1')).toEqual({
      status: 400,
      code: 'SHEET_UNTERMINATED_QUOTE',
    });
    expect(
      await db.sheetCatalog.count({ where: { tenantId: w.tenantId } }),
    ).toBe(0);
    expect(
      await db.tenantConnector.count({ where: { tenantId: w.tenantId } }),
    ).toBe(0);
  });

  it('keeps the old price list when a new file has no valid row, and takes the admin mapping', async () => {
    const w = await world();
    await controller.upload(w.as.ADMIN, SAMPLE);
    expect(
      await call(() =>
        controller.upload(w.as.ADMIN, 'Hotel,Price,Currency\nA,abc,USD'),
      ),
    ).toMatchObject({ code: 'SHEET_NO_VALID_ROWS' });
    expect((await controller.status(w.as.ADMIN)).acceptedCount).toBe(12);

    // The admin chooses the columns: here the price sits in the second column.
    const custom = 'Tour,Cost\nBeach week,500';
    const config = JSON.stringify({
      mapping: { title: 0, price: 1 },
      defaultCurrency: 'USD',
      freshnessDays: 7,
    });
    const done = await controller.upload(w.as.ADMIN, custom, config, 'own.csv');
    expect(done).toMatchObject({ accepted: 1, rejected: 0 });
    expect(await controller.status(w.as.ADMIN)).toMatchObject({
      freshnessDays: 7,
      acceptedCount: 1,
    });
  });
});
