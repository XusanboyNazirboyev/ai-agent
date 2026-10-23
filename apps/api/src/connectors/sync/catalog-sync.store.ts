import { Injectable } from '@nestjs/common';
import {
  CatalogAttributesSchema,
  ItemTypeSchema,
  normalizeCatalogText,
} from '@agentcore/shared';
import {
  Prisma,
  type CatalogSyncRun,
  type CatalogSyncStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import type { CatalogItem, Offer } from '../contracts/canonical.js';
import {
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorInvalidResponseError,
} from '../interfaces/errors.js';
import type { CatalogSyncPlan, ExistingCatalogState } from './catalog-sync.js';

// Matches offers.price DECIMAL(20, 6): anything wider would be rounded by
// PostgreSQL, silently changing a price.
const STORABLE_PRICE = /^\d{1,14}(?:\.\d{1,6})?$/;
const APPLY_TIMEOUT_MS = 120_000;

export interface SyncRunCounts {
  readonly itemsSeen: number;
  readonly itemsUpserted: number;
  readonly itemsUnchanged: number;
  readonly itemsDeactivated: number;
  readonly offersSeen: number;
  readonly offersUpserted: number;
  readonly offersUnchanged: number;
  readonly offersDeactivated: number;
}

export function planCounts(
  plan: CatalogSyncPlan,
  offersSeen: number,
): SyncRunCounts {
  return {
    itemsSeen: plan.itemUpserts.length + plan.unchangedItems.length,
    itemsUpserted: plan.itemUpserts.length,
    itemsUnchanged: plan.unchangedItems.length,
    itemsDeactivated: plan.itemDeactivations.length,
    offersSeen,
    offersUpserted: plan.offerUpserts.length,
    offersUnchanged: plan.unchangedOffers.length,
    offersDeactivated: plan.offerDeactivations.length,
  };
}

/** The run row no longer belongs to this worker (recovered as stale). */
export class CatalogSyncRunLostError extends ConnectorError {
  constructor() {
    super({
      message: 'Catalog sync run is no longer running; refusing to apply',
      code: 'CATALOG_SYNC_RUN_LOST',
      category: ConnectorErrorCategory.UNAVAILABLE,
      retryable: true,
    });
    this.name = 'CatalogSyncRunLostError';
  }
}

function invalidRecord(detail: string): never {
  throw new ConnectorInvalidResponseError({
    message: `Catalog record cannot be stored: ${detail}`,
    code: 'CATALOG_SYNC_INVALID_RECORD',
  });
}

function itemData(item: CatalogItem): {
  itemType: string;
  title: string;
  normalizedTitle: string;
  description: string | null;
  attributes: Prisma.InputJsonValue;
} {
  const itemType = ItemTypeSchema.safeParse(item.itemType);
  const attributes = CatalogAttributesSchema.safeParse({
    fields: item.attributes,
  });
  if (!itemType.success) invalidRecord('item type');
  if (!attributes.success) invalidRecord('item attributes');
  return {
    itemType: itemType.data,
    title: item.title,
    normalizedTitle: normalizeCatalogText(item.title),
    description: item.description ?? null,
    attributes: attributes.data as Prisma.InputJsonValue,
  };
}

function date(value: string | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}

/** Validates what the database CHECKs would otherwise reject mid-transaction. */
function offerData(
  offer: Offer,
): Omit<
  Prisma.OfferUncheckedCreateInput,
  | 'tenantId'
  | 'itemId'
  | 'sourceSystem'
  | 'sourceEntityId'
  | 'syncedAt'
  | 'sourceHash'
> {
  if (offer.price && !STORABLE_PRICE.test(offer.price.amount)) {
    invalidRecord('offer price is negative or too precise');
  }
  const startsAt = date(offer.startsAt);
  const endsAt = date(offer.endsAt);
  const validFrom = date(offer.validFrom);
  const validUntil = date(offer.validUntil);
  if (startsAt && endsAt && endsAt < startsAt) {
    invalidRecord('offer ends before it starts');
  }
  if (validFrom && validUntil && validUntil <= validFrom) {
    invalidRecord('offer validity window is empty');
  }
  const attributes = CatalogAttributesSchema.safeParse({
    fields: offer.attributes,
  });
  if (!attributes.success) invalidRecord('offer attributes');
  return {
    price: offer.price ? new Prisma.Decimal(offer.price.amount) : null,
    currency: offer.price?.currency ?? null,
    pricingBasis: offer.pricingBasis,
    taxesIncluded: offer.taxesIncluded ?? null,
    feesIncluded: offer.feesIncluded ?? null,
    availabilityStatus: offer.availabilityStatus,
    seatsLeft: offer.seatsLeft ?? null,
    startsAt,
    endsAt,
    validFrom,
    validUntil,
    attributes: attributes.data as Prisma.InputJsonValue,
    deletedAt: null,
  };
}

/**
 * Persistence for catalog synchronisation. Every query is tenant-scoped; a
 * plan is applied in one transaction together with the run's SUCCEEDED
 * status, so a failed or partial apply leaves no trace in the catalog and
 * never shows as a successful run.
 */
@Injectable()
export class CatalogSyncStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Starts a run. Stale runs of this connector are first recovered as
   * FAILED; if another run is still live the database's partial unique
   * index rejects the insert and `undefined` is returned.
   */
  async claimRun(
    tenantId: string,
    tenantConnectorId: string,
    options: { staleBefore: Date; now?: Date },
  ): Promise<CatalogSyncRun | undefined> {
    const now = options.now ?? new Date();
    await this.recoverStaleRuns(options.staleBefore, {
      tenantId,
      tenantConnectorId,
      now,
    });
    try {
      return await this.prisma.catalogSyncRun.create({
        data: {
          tenantId,
          tenantConnectorId,
          status: 'RUNNING',
          startedAt: now,
          heartbeatAt: now,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  /** Marks runs whose heartbeat stopped (crashed worker) as FAILED. */
  async recoverStaleRuns(
    staleBefore: Date,
    scope: { tenantId?: string; tenantConnectorId?: string; now?: Date } = {},
  ): Promise<number> {
    const result = await this.prisma.catalogSyncRun.updateMany({
      where: {
        status: 'RUNNING',
        heartbeatAt: { lt: staleBefore },
        ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
        ...(scope.tenantConnectorId
          ? { tenantConnectorId: scope.tenantConnectorId }
          : {}),
      },
      data: {
        status: 'FAILED',
        finishedAt: scope.now ?? new Date(),
        errorCode: 'CATALOG_SYNC_STALE',
        errorCategory: ConnectorErrorCategory.UNAVAILABLE,
      },
    });
    return result.count;
  }

  /** Refreshes the heartbeat; false when the run was recovered meanwhile. */
  async heartbeat(tenantId: string, runId: string): Promise<boolean> {
    const result = await this.prisma.catalogSyncRun.updateMany({
      where: { id: runId, tenantId, status: 'RUNNING' },
      data: { heartbeatAt: new Date() },
    });
    return result.count === 1;
  }

  /** True when another connector of the tenant already syncs this source. */
  async sourceSystemOwnedElsewhere(
    tenantId: string,
    tenantConnectorId: string,
    sourceSystem: string,
  ): Promise<boolean> {
    const other = await this.prisma.catalogSyncRun.findFirst({
      where: {
        tenantId,
        sourceSystem,
        tenantConnectorId: { not: tenantConnectorId },
      },
      select: { id: true },
    });
    return other !== null;
  }

  async recordSourceSystem(
    tenantId: string,
    runId: string,
    sourceSystem: string,
  ): Promise<void> {
    await this.prisma.catalogSyncRun.updateMany({
      where: { id: runId, tenantId, status: 'RUNNING' },
      data: { sourceSystem },
    });
  }

  async loadExistingState(
    tenantId: string,
    sourceSystem: string,
  ): Promise<ExistingCatalogState> {
    const [items, offers] = await Promise.all([
      this.prisma.catalogItem.findMany({
        where: { tenantId, sourceSystem },
        select: { sourceEntityId: true, sourceHash: true, status: true },
      }),
      this.prisma.offer.findMany({
        where: { tenantId, sourceSystem },
        select: { sourceEntityId: true, sourceHash: true, deletedAt: true },
      }),
    ]);
    return {
      items: items.map((item) => ({
        sourceEntityId: item.sourceEntityId,
        sourceHash: item.sourceHash,
        active: item.status === 'ACTIVE',
      })),
      offers: offers.map((offer) => ({
        sourceEntityId: offer.sourceEntityId,
        sourceHash: offer.sourceHash,
        active: offer.deletedAt === null,
      })),
    };
  }

  /**
   * Applies a plan atomically. The run row is locked first; if it is no
   * longer RUNNING (recovered as stale) nothing is written. Missing records
   * are deactivated (items INACTIVE, offers soft-deleted), never deleted.
   */
  async applyPlan(input: {
    tenantId: string;
    runId: string;
    sourceSystem: string;
    plan: CatalogSyncPlan;
    counts: SyncRunCounts;
    syncedAt?: Date;
  }): Promise<void> {
    const { tenantId, runId, sourceSystem, plan } = input;
    const syncedAt = input.syncedAt ?? new Date();
    // Validate every record before opening the transaction.
    const items = plan.itemUpserts.map((entry) => ({
      ...entry,
      data: itemData(entry.item),
    }));
    const offers = plan.offerUpserts.map((entry) => ({
      ...entry,
      data: offerData(entry.offer),
    }));

    await this.prisma.$transaction(
      async (tx) => {
        const owned = await tx.catalogSyncRun.updateMany({
          where: { id: runId, tenantId, status: 'RUNNING' },
          data: { heartbeatAt: syncedAt },
        });
        if (owned.count !== 1) throw new CatalogSyncRunLostError();

        for (const { item, sourceHash, data } of items) {
          await tx.catalogItem.upsert({
            where: {
              tenantId_sourceSystem_sourceEntityId: {
                tenantId,
                sourceSystem,
                sourceEntityId: item.sourceEntityId,
              },
            },
            create: {
              tenantId,
              sourceSystem,
              sourceEntityId: item.sourceEntityId,
              ...data,
              syncedAt,
              sourceHash,
            },
            update: {
              ...data,
              syncedAt,
              sourceHash,
              status: 'ACTIVE',
              deletedAt: null,
            },
          });
        }
        if (plan.unchangedItems.length > 0) {
          await tx.catalogItem.updateMany({
            where: {
              tenantId,
              sourceSystem,
              sourceEntityId: { in: [...plan.unchangedItems] },
            },
            data: { syncedAt },
          });
        }
        if (plan.itemDeactivations.length > 0) {
          await tx.catalogItem.updateMany({
            where: {
              tenantId,
              sourceSystem,
              status: 'ACTIVE',
              sourceEntityId: { in: [...plan.itemDeactivations] },
            },
            data: { status: 'INACTIVE' },
          });
        }

        if (offers.length > 0) {
          const parents = await tx.catalogItem.findMany({
            where: {
              tenantId,
              sourceSystem,
              sourceEntityId: {
                in: [
                  ...new Set(offers.map((entry) => entry.itemSourceEntityId)),
                ],
              },
            },
            select: { id: true, sourceEntityId: true },
          });
          const parentIds = new Map(
            parents.map((parent) => [parent.sourceEntityId, parent.id]),
          );
          for (const {
            offer,
            itemSourceEntityId,
            sourceHash,
            data,
          } of offers) {
            const itemId = parentIds.get(itemSourceEntityId);
            if (!itemId) invalidRecord('offer item is not in the catalog');
            await tx.offer.upsert({
              where: {
                tenantId_sourceSystem_sourceEntityId: {
                  tenantId,
                  sourceSystem,
                  sourceEntityId: offer.sourceEntityId,
                },
              },
              create: {
                tenantId,
                itemId,
                sourceSystem,
                sourceEntityId: offer.sourceEntityId,
                ...data,
                syncedAt,
                sourceHash,
              },
              update: { itemId, ...data, syncedAt, sourceHash },
            });
          }
        }
        if (plan.unchangedOffers.length > 0) {
          await tx.offer.updateMany({
            where: {
              tenantId,
              sourceSystem,
              sourceEntityId: { in: [...plan.unchangedOffers] },
            },
            data: { syncedAt },
          });
        }
        if (plan.offerDeactivations.length > 0) {
          await tx.offer.updateMany({
            where: {
              tenantId,
              sourceSystem,
              deletedAt: null,
              sourceEntityId: { in: [...plan.offerDeactivations] },
            },
            data: { deletedAt: syncedAt },
          });
        }

        await tx.catalogSyncRun.updateMany({
          where: { id: runId, tenantId, status: 'RUNNING' },
          data: {
            ...input.counts,
            sourceSystem,
            status: 'SUCCEEDED',
            finishedAt: new Date(),
          },
        });
      },
      { timeout: APPLY_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  /** Closes a running run as FAILED or BLOCKED with a safe error code. */
  async finishRun(
    tenantId: string,
    runId: string,
    outcome: {
      status: Extract<CatalogSyncStatus, 'FAILED' | 'BLOCKED'>;
      errorCode: string;
      errorCategory: string;
      counts?: Partial<SyncRunCounts>;
    },
  ): Promise<void> {
    await this.prisma.catalogSyncRun.updateMany({
      where: { id: runId, tenantId, status: 'RUNNING' },
      data: {
        ...outcome.counts,
        status: outcome.status,
        errorCode: outcome.errorCode.slice(0, 100),
        errorCategory: outcome.errorCategory.slice(0, 40),
        finishedAt: new Date(),
      },
    });
  }

  /** Recent runs for status visibility (newest first). */
  listRuns(
    tenantId: string,
    tenantConnectorId: string,
    limit = 20,
  ): Promise<CatalogSyncRun[]> {
    return this.prisma.catalogSyncRun.findMany({
      where: { tenantId, tenantConnectorId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }
}
