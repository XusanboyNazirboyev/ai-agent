import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Queue, Worker } from 'bullmq';
import type { RedisOptions } from 'bullmq';
import type { AppEnvironment } from '../../config/environment.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../../persistence/privileged-database.js';
import {
  runWithTenant,
  runWithoutTenant,
} from '../../persistence/tenant-context.js';
import { InboundProcessor } from '../inbound/inbound-processor.js';
import { telegramRetryDelayMs } from './retry-policy.js';
import { runWithLogContext } from '../../observability/log-context.js';
import { redisOptions } from '../../queue/redis-options.js';
import { onOutboxWritten } from './outbox-signal.js';

/**
 * ADR 005 debounce: a burst of customer messages is answered once. 1 s since
 * 2026-11-21 (was 2 s): it was half of a text reply's wait on staging.
 */
export const INBOUND_DEBOUNCE_MS = 1_000;

export type QueuePayload = {
  outboxId: string;
  tenantId: string;
  type: string;
  payload: Prisma.JsonValue;
};

const queueName = 'agentcore-telegram';

/**
 * Runs one queued event in its own log context (one trace per outbox event,
 * the same across retries) and in its tenant's database context (RLS plan
 * S6): every statement of the job carries the tenant that queued it.
 */
export function processQueuedEvent(
  processor: Pick<InboundProcessor, 'process'>,
  data: QueuePayload,
): ReturnType<InboundProcessor['process']> {
  return runWithTenant(data.tenantId, () =>
    runWithLogContext({ traceId: data.outboxId, tenantId: data.tenantId }, () =>
      processor.process(data),
    ),
  );
}
/** Publish attempts after which a FAILED outbox row is no longer re-queued. */
export const OUTBOX_MAX_ATTEMPTS = 5;

@Injectable()
export class TelegramQueueRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramQueueRuntime.name);
  private readonly connection: RedisOptions;
  private queue!: Queue<QueuePayload>;
  private worker!: Worker<QueuePayload>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private again = false;
  private stopSignal: (() => void) | undefined;
  private publishing = false;
  /**
   * The outbox relay claims due events of every tenant, so it reads and
   * writes on the privileged connection (RLS plan S6); each job then runs in
   * its own tenant's context.
   */
  private readonly relay: PrismaClient;
  private readonly concurrency: number;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    prisma: PrismaService,
    private readonly processor: InboundProcessor,
    // Optional only so specs can build it by hand; Nest always provides it.
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.connection = redisOptions(config.get('REDIS_URL', { infer: true }));
    this.relay = privileged?.db ?? prisma;
    // Jobs processed at once per API process; per-conversation order is kept
    // by the conversation lock, not by this number (load test 2026-11-18).
    this.concurrency =
      config.get('TELEGRAM_QUEUE_CONCURRENCY', { infer: true }) ?? 8;
  }

  onModuleInit(): void {
    this.queue = new Queue<QueuePayload>(queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: OUTBOX_MAX_ATTEMPTS,
        backoff: { type: 'agentcore-exponential', delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
    this.worker = new Worker<QueuePayload>(
      queueName,
      async (job, token) => {
        const result = await processQueuedEvent(this.processor, job.data);
        if (result && token) {
          // Another worker holds the conversation's agent turn: re-check
          // later without consuming a retry attempt.
          await job.moveToDelayed(result.retryAt.getTime(), token);
          throw new DelayedError();
        }
      },
      {
        connection: this.connection,
        concurrency: this.concurrency,
        settings: {
          backoffStrategy: (attemptsMade, _type, error): number =>
            telegramRetryDelayMs(attemptsMade, error),
        },
      },
    );
    this.worker.on('failed', (job, error) => {
      if (!job) return;
      this.logger.warn(
        JSON.stringify({
          event: 'telegram_job_failed',
          jobId: job.id,
          name: error.name,
        }),
      );
      if (
        (job.attemptsMade ?? 0) >= (job.opts.attempts ?? OUTBOX_MAX_ATTEMPTS)
      ) {
        void runWithTenant(job.data.tenantId, () =>
          this.processor.markExhausted(job.data),
        ).catch(() => {
          this.logger.error('Failed to persist exhausted Telegram job state');
        });
      }
    });
    this.worker.on('error', (error) => {
      const code =
        'code' in error && typeof error.code === 'string'
          ? error.code
          : 'unknown';
      this.logger.error(
        JSON.stringify({ event: 'telegram_queue_worker_error', code }),
      );
    });
    this.timer = setInterval(
      () => void runWithoutTenant(() => this.publishPending()),
      500,
    );
    this.timer.unref();
    void runWithoutTenant(() => this.publishPending());
    this.stopSignal = onOutboxWritten(
      () => void runWithoutTenant(() => this.publishPending()),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stopSignal?.();
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
  }

  private async publishPending(): Promise<void> {
    if (!this.queue) return;
    // A signal during a pass runs one more pass, so a new row never waits
    // for the next poll.
    if (this.publishing) return void (this.again = true);
    this.publishing = true;
    this.again = false;
    try {
      const staleBefore = new Date(Date.now() - 60_000);
      await this.relay.outboxEvent.updateMany({
        where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
        data: { status: 'PENDING' },
      });
      await this.relay.outboxEvent.updateMany({
        where: {
          status: 'FAILED',
          attempts: { lt: OUTBOX_MAX_ATTEMPTS },
          availableAt: { lte: new Date() },
        },
        data: { status: 'PENDING' },
      });
      const events = await this.relay.outboxEvent.findMany({
        where: {
          type: {
            in: [
              'telegram.inbound',
              'instagram.inbound',
              'facebook.inbound',
              'telegram.send',
              'instagram.comment_reply',
              'handover.notify',
              'handover.forward',
              'handover.sla',
              'crm.lead.sync',
              'action.execute',
              'digest.morning',
              'alert.operator',
            ],
          },
          status: 'PENDING',
          availableAt: { lte: new Date() },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 25,
      });
      for (const event of events) {
        const claimed = await this.relay.outboxEvent.updateMany({
          where: { id: event.id, tenantId: event.tenantId, status: 'PENDING' },
          data: { status: 'PROCESSING', attempts: { increment: 1 } },
        });
        if (claimed.count !== 1) continue;
        try {
          const data: QueuePayload = {
            outboxId: event.id,
            tenantId: event.tenantId,
            type: event.type,
            payload: event.payload,
          };
          await this.queue.add(event.type, data, {
            jobId: event.id,
            ...(event.type === 'telegram.inbound' ||
            event.type === 'instagram.inbound' ||
            event.type === 'facebook.inbound'
              ? { delay: INBOUND_DEBOUNCE_MS }
              : {}),
          });
          await this.relay.outboxEvent.updateMany({
            where: {
              id: event.id,
              tenantId: event.tenantId,
              status: 'PROCESSING',
            },
            data: { status: 'SENT' },
          });
        } catch {
          const retryDelayMs = Math.min(
            1_000 * 2 ** Math.max(event.attempts, 0),
            30_000,
          );
          await this.relay.outboxEvent.updateMany({
            where: {
              id: event.id,
              tenantId: event.tenantId,
              status: 'PROCESSING',
            },
            data: {
              status: 'FAILED',
              availableAt: new Date(Date.now() + retryDelayMs),
            },
          });
          this.logger.warn(
            JSON.stringify({
              event: 'telegram_outbox_publish_failed',
              outboxId: event.id,
            }),
          );
        }
      }
    } catch {
      this.logger.error('Telegram outbox polling failed');
    } finally {
      this.publishing = false;
      if (this.again) void runWithoutTenant(() => this.publishPending());
    }
  }
}
