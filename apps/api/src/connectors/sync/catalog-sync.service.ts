import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import {
  ConnectorConfigurationError,
  ConnectorErrorCategory,
  isConnectorError,
} from '../interfaces/errors.js';
import {
  CatalogSyncGuardError,
  fetchCatalogSnapshot,
  planCatalogSync,
} from './catalog-sync.js';
import { CatalogSyncStore, planCounts } from './catalog-sync.store.js';
import { TenantConnectorLoader } from './tenant-connector-loader.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface CatalogSyncRequest {
  readonly tenantId: string;
  readonly tenantConnectorId: string;
  /** Operator override after reviewing a BLOCKED run. */
  readonly allowMassDeactivation?: boolean;
}

export type CatalogSyncResult =
  | {
      readonly outcome: 'SUCCEEDED';
      readonly runId: string;
      readonly itemsUpserted: number;
      readonly itemsDeactivated: number;
    }
  | {
      readonly outcome: 'SKIPPED';
      readonly reason: 'CONNECTOR_INACTIVE' | 'RUN_IN_PROGRESS';
    }
  | {
      readonly outcome: 'FAILED' | 'BLOCKED';
      readonly runId: string;
      readonly errorCode: string;
      readonly retryable: boolean;
    };

/**
 * Runs one catalog synchronisation for a tenant connector: claim a run,
 * fetch a complete snapshot, plan against the stored catalog, and apply the
 * plan atomically with the run's SUCCEEDED status. Every failure closes the
 * run as FAILED (or BLOCKED for the mass-deactivation guard) with a safe
 * error code; a partial import can never look like a successful sync.
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);
  private readonly staleAfterMs: number;
  private readonly maxItems: number;

  constructor(
    private readonly store: CatalogSyncStore,
    private readonly loader: TenantConnectorLoader,
    config: ConfigService<AppEnvironment, true>,
  ) {
    this.staleAfterMs =
      config.get('CATALOG_SYNC_STALE_AFTER_SECONDS', { infer: true }) * 1_000;
    this.maxItems = config.get('CATALOG_SYNC_MAX_ITEMS', { infer: true });
  }

  get staleAfter(): number {
    return this.staleAfterMs;
  }

  async run(
    request: CatalogSyncRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<CatalogSyncResult> {
    const { tenantId, tenantConnectorId } = request;
    const row = await this.loader.findActive(tenantId, tenantConnectorId);
    if (!row) return { outcome: 'SKIPPED', reason: 'CONNECTOR_INACTIVE' };

    const run = await this.store.claimRun(tenantId, tenantConnectorId, {
      staleBefore: new Date(Date.now() - this.staleAfterMs),
    });
    if (!run) return { outcome: 'SKIPPED', reason: 'RUN_IN_PROGRESS' };

    const log = (event: string, fields: Record<string, unknown> = {}): string =>
      JSON.stringify({
        event,
        tenant: tenantId,
        tenantConnector: tenantConnectorId,
        connector: row.connectorKey,
        run: run.id,
        ...fields,
      });

    try {
      const connector = this.loader.create(row);
      const sourceSystem = connector.sourceSystem;
      if (
        sourceSystem &&
        (await this.store.sourceSystemOwnedElsewhere(
          tenantId,
          tenantConnectorId,
          sourceSystem,
        ))
      ) {
        throw new ConnectorConfigurationError({
          message: `Source system '${sourceSystem}' is already synced by another connector of this tenant`,
          code: 'CATALOG_SYNC_SOURCE_CONFLICT',
          source: row.connectorKey,
        });
      }
      if (sourceSystem) {
        await this.store.recordSourceSystem(tenantId, run.id, sourceSystem);
      }

      let lastBeat = Date.now();
      const snapshot = await fetchCatalogSnapshot(connector, {
        maxItems: this.maxItems,
        signal: options.signal,
        onItem: async () => {
          if (Date.now() - lastBeat < HEARTBEAT_INTERVAL_MS) return;
          lastBeat = Date.now();
          await this.store.heartbeat(tenantId, run.id);
        },
      });
      const existing = await this.store.loadExistingState(
        tenantId,
        snapshot.sourceSystem,
      );
      const plan = planCatalogSync(existing, snapshot, {
        allowMassDeactivation: request.allowMassDeactivation,
      });
      const offersSeen = snapshot.entries.reduce(
        (total, entry) => total + entry.offers.length,
        0,
      );
      const counts = planCounts(plan, offersSeen);
      await this.store.applyPlan({
        tenantId,
        runId: run.id,
        sourceSystem: snapshot.sourceSystem,
        plan,
        counts,
      });
      this.logger.log(log('catalog_sync.succeeded', { ...counts }));
      return {
        outcome: 'SUCCEEDED',
        runId: run.id,
        itemsUpserted: counts.itemsUpserted,
        itemsDeactivated: counts.itemsDeactivated,
      };
    } catch (error: unknown) {
      const blocked = error instanceof CatalogSyncGuardError;
      const errorCode = isConnectorError(error)
        ? error.code
        : 'CATALOG_SYNC_INTERNAL_ERROR';
      const errorCategory = isConnectorError(error)
        ? error.category
        : ConnectorErrorCategory.UNKNOWN;
      const retryable = isConnectorError(error) ? error.retryable : false;
      await this.store.finishRun(tenantId, run.id, {
        status: blocked ? 'BLOCKED' : 'FAILED',
        errorCode,
        errorCategory,
        counts: blocked
          ? {
              itemsDeactivated: (error as CatalogSyncGuardError).deactivations,
            }
          : undefined,
      });
      this.logger.warn(
        log(blocked ? 'catalog_sync.blocked' : 'catalog_sync.failed', {
          code: errorCode,
          retryable,
        }),
      );
      return {
        outcome: blocked ? 'BLOCKED' : 'FAILED',
        runId: run.id,
        errorCode,
        retryable,
      };
    }
  }
}
