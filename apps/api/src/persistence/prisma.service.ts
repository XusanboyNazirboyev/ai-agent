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
import { TenantContextAdapterFactory } from './tenant-adapter.js';
import { awaitingTenant } from './tenant-context.js';

/** At most one "no tenant" warning per this many statements (warn mode). */
const MISSING_TENANT_LOG_EVERY = 100;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(config: ConfigService<AppEnvironment, true>) {
    let missing = 0;
    const logger = new Logger(PrismaService.name);
    super({
      // RLS plan S2: with RLS_CONTEXT_MODE=off (default) this is the plain
      // PostgreSQL adapter; warn/strict give each statement its tenant.
      adapter: new TenantContextAdapterFactory(
        createPostgresAdapter({
          POSTGRES_HOST: config.get('POSTGRES_HOST', { infer: true }),
          POSTGRES_PORT: config.get('POSTGRES_PORT', { infer: true }),
          POSTGRES_DATABASE: config.get('POSTGRES_DATABASE', { infer: true }),
          POSTGRES_USER: config.get('POSTGRES_USER', { infer: true }),
          POSTGRES_PASSWORD: config.get('POSTGRES_PASSWORD', { infer: true }),
          POSTGRES_SSL_MODE: config.get('POSTGRES_SSL_MODE', { infer: true }),
        }),
        config.get('RLS_CONTEXT_MODE', { infer: true }) ?? 'off',
        (sql) => {
          // Inside a request still waiting for its tenant: every one is
          // reported (RLS plan S5 moved these to the privileged connection),
          // with the request's trace id from the log context.
          if (awaitingTenant()) {
            logger.warn(
              JSON.stringify({
                event: 'db.tenant_context_missing',
                inRequest: true,
                statement: sql.slice(0, 40),
              }),
            );
            return;
          }
          missing += 1;
          if (missing % MISSING_TENANT_LOG_EVERY !== 1) return;
          // The statement's first words only: never values.
          logger.warn(
            JSON.stringify({
              event: 'db.tenant_context_missing',
              count: missing,
              statement: sql.slice(0, 40),
            }),
          );
        },
      ),
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
