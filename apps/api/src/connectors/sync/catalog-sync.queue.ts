import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job, type RedisOptions } from 'bullmq';
import type { AppEnvironment } from '../../config/environment.js';
import { redisOptions } from '../../queue/redis-options.js';
import {
  CatalogSyncService,
  type CatalogSyncRequest,
  type CatalogSyncResult,
} from './catalog-sync.service.js';
import { CatalogSyncStore } from './catalog-sync.store.js';
import {
  newTraceId,
  runWithLogContext,
} from '../../observability/log-context.js';
import { TenantConnectorLoader } from './tenant-connector-loader.js';

export const CATALOG_SYNC_QUEUE = 'agentcore-catalog-sync';
const MAX_ATTEMPTS = 5;

/** Retryable outcome: thrown so BullMQ retries the job with backoff. */
export class CatalogSyncRetryError extends Error {
  constructor(readonly code: string) {
    super(`Catalog sync will be retried: ${code}`);
    this.name = 'CatalogSyncRetryError';
  }
}

/**
 * Decides whether a finished sync should be retried by the queue. A run that
 * is still RUNNING elsewhere is retried later: it is either a live run on
 * another worker or an orphan that stale recovery will close.
 */
export function shouldRetry(result: CatalogSyncResult): string | undefined {
  if (result.outcome === 'SKIPPED') {
    return result.reason === 'RUN_IN_PROGRESS' ? result.reason : undefined;
  }
  if (result.outcome === 'FAILED' && result.retryable) return result.errorCode;
  return undefined;
}

/**
 * BullMQ transport for catalog sync (PostgreSQL run rows are the source of
 * truth for status). Jobs are deduplicated per tenant connector while queued
 * or active; the database's one-running-run index is the authoritative
 * overlap guard. On shutdown, in-flight syncs are aborted and close their run
 * as FAILED instead of being left RUNNING.
 */
@Injectable()
export class CatalogSyncQueueRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogSyncQueueRuntime.name);
  private readonly connection: RedisOptions;
  private readonly intervalMs: number;
  private queue: Queue<CatalogSyncRequest> | undefined;
  private worker: Worker<CatalogSyncRequest> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly shutdown = new AbortController();

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly service: CatalogSyncService,
    private readonly store: CatalogSyncStore,
    private readonly loader: TenantConnectorLoader,
  ) {
    this.connection = redisOptions(config.get('REDIS_URL', { infer: true }));
    this.intervalMs =
      config.get('CATALOG_SYNC_INTERVAL_MINUTES', { infer: true }) * 60_000;
  }

  onModuleInit(): void {
    this.queue = new Queue<CatalogSyncRequest>(CATALOG_SYNC_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
    this.worker = new Worker<CatalogSyncRequest>(
      CATALOG_SYNC_QUEUE,
      (job) =>
        runWithLogContext(
          { traceId: job.id ?? newTraceId(), tenantId: job.data.tenantId },
          () => this.process(job),
        ),
      { connection: this.connection, concurrency: 2 },
    );
    this.worker.on('error', (error) => {
      this.logger.error(
        JSON.stringify({
          event: 'catalog_sync_worker_error',
          name: error.name,
        }),
      );
    });
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => void this.schedule(), this.intervalMs);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
  }

  async process(job: Pick<Job<CatalogSyncRequest>, 'data'>): Promise<void> {
    const result = await this.service.run(job.data, {
      signal: this.shutdown.signal,
    });
    const retry = shouldRetry(result);
    if (retry) throw new CatalogSyncRetryError(retry);
  }

  /** Requests a sync; a queued or running job for the connector absorbs it. */
  async enqueue(request: CatalogSyncRequest): Promise<void> {
    if (!this.queue) throw new Error('Catalog sync queue is not started');
    const id = `catalog-sync:${request.tenantId}:${request.tenantConnectorId}`;
    await this.queue.add('catalog.sync', request, {
      deduplication: { id },
    });
  }

  /**
   * Scheduler tick: closes stale runs, then enqueues every active connector
   * that can sync. A connector whose configuration no longer validates is
   * still enqueued so the problem is recorded as a FAILED run (not retried).
   */
  async schedule(): Promise<void> {
    try {
      await this.store.recoverStaleRuns(
        new Date(Date.now() - this.service.staleAfter),
      );
      for (const row of await this.loader.listActive()) {
        let syncable = false;
        try {
          syncable = this.loader.create(row).capabilities.sync;
        } catch {
          syncable = true;
        }
        if (!syncable) continue;
        await this.enqueue({
          tenantId: row.tenantId,
          tenantConnectorId: row.id,
        });
      }
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'catalog_sync_schedule_failed',
          name: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }
}
