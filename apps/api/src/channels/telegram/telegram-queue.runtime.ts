import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Queue, Worker } from 'bullmq';
import type { RedisOptions } from 'bullmq';
import type { AppEnvironment } from '../../config/environment.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { TelegramProcessor } from './telegram-processor.js';
import { telegramRetryDelayMs } from './retry-policy.js';
import { redisOptions } from '../../queue/redis-options.js';

type QueuePayload = {
  outboxId: string;
  tenantId: string;
  type: string;
  payload: Prisma.JsonValue;
};

const queueName = 'agentcore-telegram';
/** Publish attempts after which a FAILED outbox row is no longer re-queued. */
export const OUTBOX_MAX_ATTEMPTS = 5;

@Injectable()
export class TelegramQueueRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramQueueRuntime.name);
  private readonly connection: RedisOptions;
  private queue!: Queue<QueuePayload>;
  private worker!: Worker<QueuePayload>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private publishing = false;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly prisma: PrismaService,
    private readonly processor: TelegramProcessor,
  ) {
    this.connection = redisOptions(config.get('REDIS_URL', { infer: true }));
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
        const result = await this.processor.process(job.data);
        if (result && token) {
          // Another worker holds the conversation's agent turn: re-check
          // later without consuming a retry attempt.
          await job.moveToDelayed(result.retryAt.getTime(), token);
          throw new DelayedError();
        }
      },
      {
        connection: this.connection,
        concurrency: 8,
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
        void this.processor.markExhausted(job.data).catch(() => {
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
    this.timer = setInterval(() => void this.publishPending(), 500);
    this.timer.unref();
    void this.publishPending();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
  }

  private async publishPending(): Promise<void> {
    if (this.publishing || !this.queue) return;
    this.publishing = true;
    try {
      const staleBefore = new Date(Date.now() - 60_000);
      await this.prisma.outboxEvent.updateMany({
        where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
        data: { status: 'PENDING' },
      });
      await this.prisma.outboxEvent.updateMany({
        where: {
          status: 'FAILED',
          attempts: { lt: OUTBOX_MAX_ATTEMPTS },
          availableAt: { lte: new Date() },
        },
        data: { status: 'PENDING' },
      });
      const events = await this.prisma.outboxEvent.findMany({
        where: {
          type: {
            in: [
              'telegram.inbound',
              'telegram.send',
              'handover.notify',
              'handover.forward',
              'handover.sla',
              'crm.lead.sync',
              'action.execute',
              'digest.morning',
            ],
          },
          status: 'PENDING',
          availableAt: { lte: new Date() },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 25,
      });
      for (const event of events) {
        const claimed = await this.prisma.outboxEvent.updateMany({
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
            ...(event.type === 'telegram.inbound' ? { delay: 2_000 } : {}),
          });
          await this.prisma.outboxEvent.updateMany({
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
          await this.prisma.outboxEvent.updateMany({
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
    }
  }
}
