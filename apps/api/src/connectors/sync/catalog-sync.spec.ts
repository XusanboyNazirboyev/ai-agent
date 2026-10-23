import { describe, expect, it } from 'vitest';
import type { CatalogItem, Offer } from '../contracts/canonical.js';
import type { CrmConnector } from '../interfaces/crm-connector.js';
import {
  ConnectorErrorCategory,
  ConnectorUnavailableError,
} from '../interfaces/errors.js';
import { MockConnector } from '../mock/mock-connector.js';
import { allFixtures } from '../mock/mock-fixtures.js';
import {
  catalogSourceHash,
  fetchCatalogSnapshot,
  planCatalogSync,
  type CatalogSnapshot,
  type ExistingCatalogState,
} from './catalog-sync.js';

const context = { tenantId: 'tenant-a', connectorKey: 'mock' };

function mock(): MockConnector {
  return new MockConnector(context, {
    sourceSystem: 'mock-education',
    items: allFixtures('mock-education'),
  });
}

function item(id: string, title = `Fictional ${id}`): CatalogItem {
  return {
    id: `src:${id}`,
    sourceSystem: 'src',
    sourceEntityId: id,
    itemType: 'item',
    title,
    attributes: {},
  };
}

function offer(id: string, itemId: string): Offer {
  return {
    id: `src:offer:${id}`,
    itemId: `src:${itemId}`,
    sourceSystem: 'src',
    sourceEntityId: id,
    price: { amount: '10.00', currency: 'USD' },
    pricingBasis: 'TOTAL',
    availabilityStatus: 'AVAILABLE',
    attributes: {},
  };
}

function snapshot(
  entries: Array<{ item: CatalogItem; offers?: Offer[] }>,
  offersIncluded = true,
): CatalogSnapshot {
  return {
    sourceSystem: 'src',
    offersIncluded,
    entries: entries.map((entry) => ({
      item: entry.item,
      offers: entry.offers ?? [],
    })),
  };
}

function existing(
  items: CatalogItem[],
  offers: Offer[] = [],
  active = true,
): ExistingCatalogState {
  return {
    items: items.map((record) => ({
      sourceEntityId: record.sourceEntityId,
      sourceHash: catalogSourceHash(record),
      active,
    })),
    offers: offers.map((record) => ({
      sourceEntityId: record.sourceEntityId,
      sourceHash: catalogSourceHash(record),
      active,
    })),
  };
}

describe('fetchCatalogSnapshot', () => {
  it('captures every item with its offers', async () => {
    const result = await fetchCatalogSnapshot(mock(), { maxItems: 100 });
    expect(result.sourceSystem).toBe('mock-education');
    expect(result.offersIncluded).toBe(true);
    expect(result.entries.map((entry) => entry.item.sourceEntityId)).toEqual([
      'edu-ielts-001',
      'edu-english-001',
    ]);
    expect(result.entries[0].offers).toHaveLength(2);
  });

  it('fails entirely when one offer lookup fails (no partial snapshot)', async () => {
    const connector = mock();
    let calls = 0;
    const flaky: CrmConnector = {
      ...connector,
      connectorKey: connector.connectorKey,
      capabilities: connector.capabilities,
      context: connector.context,
      listItems: (params) => connector.listItems(params),
      getOffers: async (itemId) => {
        if (++calls === 2) {
          throw new ConnectorUnavailableError({ message: 'fictional outage' });
        }
        return connector.getOffers(itemId);
      },
    };
    await expect(
      fetchCatalogSnapshot(flaky, { maxItems: 100 }),
    ).rejects.toMatchObject({ category: ConnectorErrorCategory.UNAVAILABLE });
  });

  it('leaves offers out when the connector cannot list them', async () => {
    const connector = mock();
    const itemsOnly: CrmConnector = {
      sourceSystem: connector.sourceSystem,
      connectorKey: connector.connectorKey,
      context: connector.context,
      capabilities: connector.capabilities,
      listItems: (params) => connector.listItems(params),
    };
    const result = await fetchCatalogSnapshot(itemsOnly, { maxItems: 100 });
    expect(result.offersIncluded).toBe(false);
  });

  it('refuses connectors without sync, oversized catalogs and cancelled runs', async () => {
    const connector = mock();
    await expect(
      fetchCatalogSnapshot(
        {
          connectorKey: 'none',
          context,
          capabilities: { ...connector.capabilities, sync: false },
        },
        { maxItems: 100 },
      ),
    ).rejects.toMatchObject({ code: 'CONNECTOR_CAPABILITY_UNSUPPORTED' });
    await expect(
      fetchCatalogSnapshot(connector, { maxItems: 1 }),
    ).rejects.toMatchObject({ code: 'CATALOG_SYNC_TOO_LARGE' });
    await expect(
      fetchCatalogSnapshot(connector, {
        maxItems: 100,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_SYNC_CANCELLED' });
  });

  it('scopes an empty listing to the connector source system', async () => {
    const empty = new MockConnector(context, {
      sourceSystem: 'mock-education',
      items: [],
    });
    const result = await fetchCatalogSnapshot(empty, { maxItems: 100 });
    expect(result).toMatchObject({
      sourceSystem: 'mock-education',
      entries: [],
    });
  });

  it('refuses connectors that do not declare a source system', async () => {
    const connector = mock();
    await expect(
      fetchCatalogSnapshot(
        {
          connectorKey: connector.connectorKey,
          context: connector.context,
          capabilities: connector.capabilities,
          listItems: (params) => connector.listItems(params),
        },
        { maxItems: 100 },
      ),
    ).rejects.toMatchObject({ code: 'CONNECTOR_SOURCE_SYSTEM_MISSING' });
  });

  it('rejects offers attached to the wrong item', async () => {
    const connector = mock();
    const crossed: CrmConnector = {
      sourceSystem: connector.sourceSystem,
      connectorKey: connector.connectorKey,
      context: connector.context,
      capabilities: connector.capabilities,
      listItems: (params) => connector.listItems(params),
      getOffers: async () => [offer('o-1', 'someone-else')],
    };
    await expect(
      fetchCatalogSnapshot(crossed, { maxItems: 100 }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_IDENTITY_MISMATCH' });
  });
});

describe('planCatalogSync', () => {
  it('upserts everything into an empty catalog', () => {
    const plan = planCatalogSync(
      existing([]),
      snapshot([{ item: item('a'), offers: [offer('o-1', 'a')] }]),
    );
    expect(plan.itemUpserts.map((entry) => entry.item.sourceEntityId)).toEqual([
      'a',
    ]);
    expect(plan.offerUpserts).toMatchObject([{ itemSourceEntityId: 'a' }]);
    expect(plan.itemDeactivations).toEqual([]);
  });

  it('is idempotent: an unchanged snapshot writes nothing', () => {
    const records = [item('a'), item('b')];
    const offers = [offer('o-1', 'a')];
    const plan = planCatalogSync(
      existing(records, offers),
      snapshot([{ item: records[0], offers }, { item: records[1] }]),
    );
    expect(plan.itemUpserts).toEqual([]);
    expect(plan.offerUpserts).toEqual([]);
    expect(plan.unchangedItems).toEqual(['a', 'b']);
    expect(plan.unchangedOffers).toEqual(['o-1']);
  });

  it('upserts changed and reactivated records', () => {
    const plan = planCatalogSync(
      {
        items: [
          ...existing([item('a')]).items,
          ...existing([item('b')], [], false).items,
        ],
        offers: [],
      },
      snapshot([
        { item: item('a', 'Renamed fictional a') },
        { item: item('b') },
      ]),
    );
    expect(plan.itemUpserts.map((entry) => entry.item.sourceEntityId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('deactivates a small share of missing records', () => {
    const records = Array.from({ length: 10 }, (_, index) => item(`i${index}`));
    const plan = planCatalogSync(
      existing(records),
      snapshot(records.slice(1).map((record) => ({ item: record }))),
    );
    expect(plan.itemDeactivations).toEqual(['i0']);
  });

  it('refuses to deactivate most of the catalog after a bad upstream answer', () => {
    const records = Array.from({ length: 10 }, (_, index) => item(`i${index}`));
    for (const partial of [[], records.slice(0, 4)]) {
      expect(() =>
        planCatalogSync(
          existing(records),
          snapshot(partial.map((record) => ({ item: record }))),
        ),
      ).toThrow(
        expect.objectContaining({ code: 'CATALOG_SYNC_MASS_DEACTIVATION' }),
      );
    }
    expect(
      planCatalogSync(existing(records), snapshot([]), {
        allowMassDeactivation: true,
      }).itemDeactivations,
    ).toHaveLength(10);
  });

  it('refuses a snapshot whose offers all vanished', () => {
    expect(() =>
      planCatalogSync(
        existing([item('a')], [offer('o-1', 'a')]),
        snapshot([{ item: item('a'), offers: [] }]),
      ),
    ).toThrow(
      expect.objectContaining({ code: 'CATALOG_SYNC_MASS_DEACTIVATION' }),
    );
  });

  it('never touches offers when the snapshot did not include them', () => {
    const plan = planCatalogSync(
      existing([item('a')], [offer('o-1', 'a')]),
      snapshot([{ item: item('a') }], false),
    );
    expect(plan.offerDeactivations).toEqual([]);
    expect(plan.offerUpserts).toEqual([]);
  });

  it('hashes records independently of key order', () => {
    const a = item('a');
    const reordered = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as CatalogItem;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a));
    expect(catalogSourceHash(reordered)).toBe(catalogSourceHash(a));
    expect(catalogSourceHash(item('a', 'Different'))).not.toBe(
      catalogSourceHash(a),
    );
  });
});
