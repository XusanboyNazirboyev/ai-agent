import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client.js';
import type { AppEnvironment } from '../config/environment.js';
import { assertUtcSession, createPostgresAdapter } from './postgres-adapter.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(config: ConfigService<AppEnvironment, true>) {
    super({
      adapter: createPostgresAdapter({
        POSTGRES_HOST: config.get('POSTGRES_HOST', { infer: true }),
        POSTGRES_PORT: config.get('POSTGRES_PORT', { infer: true }),
        POSTGRES_DATABASE: config.get('POSTGRES_DATABASE', { infer: true }),
        POSTGRES_USER: config.get('POSTGRES_USER', { infer: true }),
        POSTGRES_PASSWORD: config.get('POSTGRES_PASSWORD', { infer: true }),
        POSTGRES_SSL_MODE: config.get('POSTGRES_SSL_MODE', { infer: true }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await assertUtcSession(this);
  }

  /**
   * The pool closes last: Nest runs every module's onModuleDestroy (queue
   * workers finishing their active job, timers stopping) before any
   * onApplicationShutdown, so a job still writing has its connection.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.$disconnect();
    // The last step of a graceful stop: seen in the logs after a deploy.
    new Logger(PrismaService.name).log(
      JSON.stringify({
        event: 'app.shutdown_complete',
        signal: signal ?? null,
      }),
    );
  }

  /**
   * Runs work in a transaction with the tenant context set for RLS (ADR 050).
   * Use for tenant-scoped operations that must be enforced by Postgres policies
   * when the DB role does not bypass RLS. Requires an interactive transaction.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: PrismaService) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as PrismaService);
    });
  }
}
