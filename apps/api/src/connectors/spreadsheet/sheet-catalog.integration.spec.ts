/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { parseSheet } from './csv-reader.js';
import { suggestMapping } from './field-suggest.js';
import { mapSheet } from './row-mapper.js';
import {
  PrismaSheetCatalogStore,
  type SheetCatalogInput,
} from './sheet-catalog.store.js';
import { SpreadsheetConnector } from './spreadsheet-connector.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error(
    'Spreadsheet catalog integration tests require agentcore_test',
  );
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
const store = new PrismaSheetCatalogStore(prisma);
afterAll(async () => {
  await db.$disconnect();
});

const SAMPLE = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../../docs/samples/tourism-price-list.sample.csv',
  ),
  'utf8',
);

async function tenant(): Promise<string> {
  const created = await db.tenant.create({
    data: {
      slug: `sheet-${randomUUID()}`,
      name: 'Sheet fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'travel',
      packVersion: '1',
    },
  });
  return created.id;
}

function input(
  csv: string,
  uploadedAt: Date,
  freshnessDays = 3,
): SheetCatalogInput {
  const sheet = parseSheet(csv);
  const mapping = suggestMapping(sheet.header);
  return {
    name: 'Price list',
    sourceFilename: 'prices.csv',
    mapping,
    options: {},
    freshnessDays,
    uploadedAt,
    result: mapSheet(sheet, mapping),
  };
}

const connectorFor = (tenantId: string, now: () => Date) =>
  new SpreadsheetConnector(
    { tenantId, connectorKey: 'spreadsheet' },
    store,
    now,
  );

const NOW = new Date('2026-03-01T08:00:00Z');

describe('spreadsheet catalog (ADR 064)', () => {
  it('stores the sample and answers search, offers, availability and quotes', async () => {
    const tenantId = await tenant();
    const meta = await store.replace(tenantId, input(SAMPLE, NOW));
    expect(meta).toMatchObject({
      rowCount: 15,
      acceptedCount: 12,
      rejectedCount: 3,
    });
    const connector = connectorFor(tenantId, () => NOW);

    const dubai = await connector.searchItems({ title: 'dubai' });
    expect(dubai.map((i) => i.attributes.hotel).sort()).toEqual([
      'Atlantis Sample Hotel',
      'Rixos Premium Palm',
    ]);
    expect(
      (
        await connector.searchItems({ attributes: { destination: 'hurghada' } })
      ).map((i) => i.title),
    ).toEqual(['Hurghada · Sun Garden Hotel 4★ · 7 nights · AI']);
    expect(
      await connector.searchItems({ attributes: { nights: 7 } }),
    ).toHaveLength(4);
    // Wildcards and odd attribute names are data, never patterns.
    expect(await connector.searchItems({ title: '%' })).toHaveLength(0);
    expect(
      await connector.searchItems({ attributes: { 'x"; drop': 'y' } }),
    ).toHaveLength(0);

    const rixos = dubai.find(
      (i) => i.attributes.hotel === 'Rixos Premium Palm',
    )!;
    const offers = await connector.getOffers(rixos.id);
    expect(offers).toHaveLength(4);
    const first = offers.find((o) => o.sourceEntityId === 'DXB-RIX-5-0314')!;
    expect(first).toMatchObject({
      price: { amount: '820', currency: 'USD' },
      pricingBasis: 'PER_PERSON',
      availabilityStatus: 'AVAILABLE',
      seatsLeft: 6,
      startsAt: '2026-03-14T00:00:00+05:00',
      endsAt: '2026-03-19T00:00:00+05:00',
    });
    expect(first.attributes).toMatchObject({
      room: 'DBL',
      departureDate: '2026-03-14',
    });

    expect(
      await connector.checkAvailability(first.id, { offerId: first.id }),
    ).toMatchObject({
      status: 'AVAILABLE',
      seatsLeft: 6,
    });
    const soldOut = offers.find((o) => o.sourceEntityId === 'DXB-RIX-5-0328')!;
    expect(
      (await connector.checkAvailability(soldOut.id, { offerId: soldOut.id }))
        .status,
    ).toBe('SOLD_OUT');
    expect(
      await connector.getQuote(first.id, { offerId: first.id }),
    ).toMatchObject({
      amount: { amount: '820', currency: 'USD' },
      pricingBasis: 'PER_PERSON',
      sourceSystem: 'spreadsheet',
    });
    await expect(
      connector.getQuote('spreadsheet:NO-SUCH', { offerId: 'x' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_OFFER_NOT_FOUND' });
  });

  it('does not quote a stale price list and reports availability unknown', async () => {
    const tenantId = await tenant();
    await store.replace(tenantId, input(SAMPLE, NOW, 3));
    const later = new Date(NOW.getTime() + 4 * 86_400_000);
    const stale = connectorFor(tenantId, () => later);
    const item = (await stale.searchItems({ title: 'rixos' }))[0]!;
    const offers = await stale.getOffers(item.id);
    expect(offers.every((o) => o.availabilityStatus === 'UNKNOWN')).toBe(true);
    expect(offers.every((o) => o.seatsLeft === undefined)).toBe(true);
    expect(
      (await stale.checkAvailability(offers[0]!.id, { offerId: offers[0]!.id }))
        .status,
    ).toBe('UNKNOWN');
    await expect(
      stale.getQuote(offers[0]!.id, { offerId: offers[0]!.id }),
    ).rejects.toMatchObject({ code: 'SHEET_CATALOG_STALE' });
    // The same data is quoted while it is fresh.
    const fresh = connectorFor(
      tenantId,
      () => new Date(NOW.getTime() + 2 * 86_400_000),
    );
    await expect(
      fresh.getQuote(offers[0]!.id, { offerId: offers[0]!.id }),
    ).resolves.toMatchObject({ amount: { amount: '820' } });
  });

  it('replaces the whole list in one transaction and keeps the old one when it fails', async () => {
    const tenantId = await tenant();
    await store.replace(tenantId, input(SAMPLE, NOW));
    const connector = connectorFor(tenantId, () => NOW);

    const smaller = 'Code,Hotel,Price,Currency\nONLY-1,Solo Hotel,100,USD';
    const meta = await store.replace(tenantId, input(smaller, NOW));
    expect(meta).toMatchObject({ acceptedCount: 1 });
    expect(await connector.searchItems({ title: 'rixos' })).toHaveLength(0);
    expect(await connector.searchItems({ title: 'solo' })).toHaveLength(1);

    // A broken batch (the same offer key twice) must leave the list as it was.
    const good = input(smaller, NOW);
    const broken: SheetCatalogInput = {
      ...good,
      result: {
        ...good.result,
        offers: [good.result.offers[0]!, good.result.offers[0]!],
      },
    };
    await expect(store.replace(tenantId, broken)).rejects.toThrow();
    expect(await connector.searchItems({ title: 'solo' })).toHaveLength(1);
    expect(await db.sheetCatalogOffer.count({ where: { tenantId } })).toBe(1);
    expect((await store.meta(tenantId))!.acceptedCount).toBe(1);
  });

  it('keeps tenants apart', async () => {
    const a = await tenant();
    const b = await tenant();
    await store.replace(a, input(SAMPLE, NOW));
    const other = connectorFor(b, () => NOW);
    expect(await other.searchItems({ title: 'dubai' })).toEqual([]);
    expect(await store.getOffer(b, 'DXB-RIX-5-0314')).toBeNull();
    await expect(
      other.getQuote('spreadsheet:DXB-RIX-5-0314', { offerId: 'x' }),
    ).rejects.toMatchObject({ code: 'SHEET_CATALOG_EMPTY' });
    // The offer exists for tenant A only.
    expect(await store.getOffer(a, 'DXB-RIX-5-0314')).not.toBeNull();
  });
});
