import { createHash } from 'node:crypto';
import type { CatalogItem, Offer } from '../contracts/canonical.js';
import type { CrmConnector } from '../interfaces/crm-connector.js';
import {
  ConnectorCapabilityError,
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorInvalidResponseError,
} from '../interfaces/errors.js';
import { stableStringify } from '../stable-json.js';

/**
 * Catalog synchronisation core: fetches a complete, validated snapshot from a
 * connector and plans idempotent changes against the local copy.
 *
 * Safety rules (AGENTS.md §8 / D10):
 * - A snapshot is all-or-nothing. A failed page, item or offer lookup fails
 *   the whole fetch; a partial snapshot is never planned, so a transient CRM
 *   failure can never look like "these records were deleted".
 * - Records missing from a snapshot are only *deactivated* (never deleted),
 *   and a plan that would deactivate a large share of the active catalog is
 *   refused unless an operator explicitly allows it.
 * - Offers are only reconciled when the connector can list them; otherwise
 *   local offers are left untouched.
 * - Synced prices and availability are cached copies for search. They are not
 *   live quotes: anything shown to a customer is re-checked live first.
 *
 * Persistence (tenant-scoped upserts keyed by tenant, sourceSystem and
 * sourceEntityId), run status and BullMQ scheduling build on this module.
 */

export interface CatalogSnapshotEntry {
  readonly item: CatalogItem;
  readonly offers: readonly Offer[];
}

export interface CatalogSnapshot {
  readonly sourceSystem: string;
  readonly entries: readonly CatalogSnapshotEntry[];
  /** False when the connector has no offer listing; offers are then untouched. */
  readonly offersIncluded: boolean;
}

export interface FetchSnapshotOptions {
  /** Upper bound on catalog size; larger listings fail rather than truncate. */
  readonly maxItems: number;
  readonly signal?: AbortSignal;
  /** Called before each item's offers are fetched (heartbeats, cancellation). */
  readonly onItem?: () => Promise<void>;
}

function invalid(code: string, message: string, source: string): never {
  throw new ConnectorInvalidResponseError({ message, code, source });
}

export async function fetchCatalogSnapshot(
  connector: CrmConnector,
  options: FetchSnapshotOptions,
): Promise<CatalogSnapshot> {
  const source = connector.connectorKey;
  if (!connector.capabilities.sync || !connector.listItems) {
    throw new ConnectorCapabilityError({
      message: `Connector '${source}' cannot list its catalog for sync`,
      code: 'CONNECTOR_CAPABILITY_UNSUPPORTED',
      source,
    });
  }
  // The reconciliation scope must come from the connector, never from the
  // records: an empty listing would otherwise have no scope, and the
  // mass-deactivation guard could not see that the catalog vanished.
  const sourceSystem = connector.sourceSystem;
  if (!sourceSystem) {
    throw new ConnectorCapabilityError({
      message: `Connector '${source}' does not declare a source system`,
      code: 'CONNECTOR_SOURCE_SYSTEM_MISSING',
      source,
    });
  }

  const throwIfCancelled = (): void => {
    if (options.signal?.aborted) {
      throw new ConnectorError({
        message: `Catalog sync cancelled for connector '${source}'`,
        code: 'CATALOG_SYNC_CANCELLED',
        category: ConnectorErrorCategory.CANCELLED,
        source,
      });
    }
  };

  throwIfCancelled();
  // listItems returns the complete listing or throws (it never truncates).
  const items = await connector.listItems({});
  if (items.length > options.maxItems) {
    invalid(
      'CATALOG_SYNC_TOO_LARGE',
      `Catalog has ${items.length} items, above the sync limit of ${options.maxItems}`,
      source,
    );
  }
  if (items.some((item) => item.sourceSystem !== sourceSystem)) {
    invalid(
      'CATALOG_SYNC_MIXED_SOURCES',
      'Catalog items do not match the connector source system',
      source,
    );
  }
  const itemIds = new Set(items.map((item) => item.sourceEntityId));
  if (itemIds.size !== items.length) {
    invalid('CATALOG_SYNC_DUPLICATE_ITEM', 'Duplicate item ids', source);
  }

  const offersIncluded = typeof connector.getOffers === 'function';
  const seenOffers = new Set<string>();
  const entries: CatalogSnapshotEntry[] = [];
  for (const item of items) {
    throwIfCancelled();
    await options.onItem?.();
    const offers = offersIncluded ? await connector.getOffers!(item.id) : [];
    for (const offer of offers) {
      if (offer.itemId !== item.id) {
        invalid(
          'CONNECTOR_IDENTITY_MISMATCH',
          'Offer listed for an item it does not belong to',
          source,
        );
      }
      if (seenOffers.has(offer.sourceEntityId)) {
        invalid(
          'CATALOG_SYNC_DUPLICATE_OFFER',
          'An offer is listed under more than one item',
          source,
        );
      }
      seenOffers.add(offer.sourceEntityId);
    }
    entries.push({ item, offers });
  }

  return {
    sourceSystem,
    entries,
    offersIncluded,
  };
}

/** Content hash used to skip writes for unchanged records. */
export function catalogSourceHash(record: CatalogItem | Offer): string {
  return createHash('sha256').update(stableStringify(record)).digest('hex');
}

export interface ExistingCatalogRecord {
  readonly sourceEntityId: string;
  readonly sourceHash: string;
  readonly active: boolean;
}

export interface ExistingCatalogState {
  readonly items: readonly ExistingCatalogRecord[];
  readonly offers: readonly ExistingCatalogRecord[];
}

export interface CatalogSyncPlan {
  readonly itemUpserts: ReadonlyArray<{
    readonly item: CatalogItem;
    readonly sourceHash: string;
  }>;
  /** Present and unchanged: only `syncedAt` needs refreshing. */
  readonly unchangedItems: readonly string[];
  readonly itemDeactivations: readonly string[];
  readonly offerUpserts: ReadonlyArray<{
    readonly offer: Offer;
    readonly itemSourceEntityId: string;
    readonly sourceHash: string;
  }>;
  readonly unchangedOffers: readonly string[];
  readonly offerDeactivations: readonly string[];
}

export interface SyncGuardOptions {
  /** Largest share of active items one run may deactivate (default 0.5). */
  readonly maxItemDeactivationRatio?: number;
  /** Operator override after reviewing a blocked run. */
  readonly allowMassDeactivation?: boolean;
}

export class CatalogSyncGuardError extends ConnectorError {
  constructor(
    readonly activeItems: number,
    readonly deactivations: number,
    detail: string,
  ) {
    super({
      message: `Catalog sync refused: ${detail} (${deactivations} of ${activeItems} active records)`,
      code: 'CATALOG_SYNC_MASS_DEACTIVATION',
      category: ConnectorErrorCategory.VALIDATION,
      retryable: false,
    });
    this.name = 'CatalogSyncGuardError';
  }
}

export function planCatalogSync(
  existing: ExistingCatalogState,
  snapshot: CatalogSnapshot,
  options: SyncGuardOptions = {},
): CatalogSyncPlan {
  const ratio = options.maxItemDeactivationRatio ?? 0.5;
  const existingItems = new Map(
    existing.items.map((record) => [record.sourceEntityId, record]),
  );
  const existingOffers = new Map(
    existing.offers.map((record) => [record.sourceEntityId, record]),
  );

  const itemUpserts: Array<{ item: CatalogItem; sourceHash: string }> = [];
  const unchangedItems: string[] = [];
  const offerUpserts: Array<{
    offer: Offer;
    itemSourceEntityId: string;
    sourceHash: string;
  }> = [];
  const unchangedOffers: string[] = [];
  const presentItems = new Set<string>();
  const presentOffers = new Set<string>();

  for (const entry of snapshot.entries) {
    const { item } = entry;
    presentItems.add(item.sourceEntityId);
    const sourceHash = catalogSourceHash(item);
    const current = existingItems.get(item.sourceEntityId);
    if (current?.active && current.sourceHash === sourceHash) {
      unchangedItems.push(item.sourceEntityId);
    } else {
      itemUpserts.push({ item, sourceHash }); // new, changed or reactivated
    }

    if (!snapshot.offersIncluded) continue;
    for (const offer of entry.offers) {
      presentOffers.add(offer.sourceEntityId);
      const offerHash = catalogSourceHash(offer);
      const currentOffer = existingOffers.get(offer.sourceEntityId);
      if (currentOffer?.active && currentOffer.sourceHash === offerHash) {
        unchangedOffers.push(offer.sourceEntityId);
      } else {
        offerUpserts.push({
          offer,
          itemSourceEntityId: item.sourceEntityId,
          sourceHash: offerHash,
        });
      }
    }
  }

  const activeItems = existing.items.filter((record) => record.active);
  const itemDeactivations = activeItems
    .filter((record) => !presentItems.has(record.sourceEntityId))
    .map((record) => record.sourceEntityId);
  const activeOffers = existing.offers.filter((record) => record.active);
  const offerDeactivations = snapshot.offersIncluded
    ? activeOffers
        .filter((record) => !presentOffers.has(record.sourceEntityId))
        .map((record) => record.sourceEntityId)
    : [];

  if (!options.allowMassDeactivation) {
    if (
      activeItems.length > 0 &&
      itemDeactivations.length / activeItems.length > ratio
    ) {
      throw new CatalogSyncGuardError(
        activeItems.length,
        itemDeactivations.length,
        'too many catalog items would be deactivated',
      );
    }
    if (
      snapshot.offersIncluded &&
      activeOffers.length > 0 &&
      presentOffers.size === 0
    ) {
      throw new CatalogSyncGuardError(
        activeOffers.length,
        offerDeactivations.length,
        'the upstream returned no offers at all',
      );
    }
  }

  return {
    itemUpserts,
    unchangedItems,
    itemDeactivations,
    offerUpserts,
    unchangedOffers,
    offerDeactivations,
  };
}
