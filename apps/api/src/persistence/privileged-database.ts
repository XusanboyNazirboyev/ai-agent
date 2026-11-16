import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { assertUtcSession, createPostgresAdapter } from './postgres-adapter.js';
import { PrismaService } from './prisma.service.js';

/**
 * The database connection for work that legitimately spans tenants (RLS plan
 * S3, docs/design/rls-enforcement-plan-2026-11-16.md): sign-in lookups,
 * webhook routing to a tenant, outbox publishing, the inbox event poller,
 * scheduled scans that find due work, the platform console and ops scripts.
 *
 * With `POSTGRES_ADMIN_USER` unset, `db` is the main `PrismaService` (no extra
 * pool, today's behaviour). Set, it is its own pool as that role (the table
 * owner, which RLS does not bind) and is never given a tenant context.
 * Only the files listed in `privileged-database.spec.ts` may inject it.
 */
@Injectable()
export class PrivilegedDatabase implements OnModuleInit, OnApplicationShutdown {
  readonly db: PrismaClient;
  private readonly own: PrismaClient | null;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppEnvironment, true>,
    @Inject(PrismaService) main: PrismaService,
  ) {
    const user = config.get('POSTGRES_ADMIN_USER', { infer: true });
    const password = config.get('POSTGRES_ADMIN_PASSWORD', { infer: true });
    if (!user) {
      this.own = null;
      this.db = main;
      return;
    }
    const pick = <K extends keyof AppEnvironment>(
      admin: K,
      fallback: K,
    ): AppEnvironment[K] =>
      config.get(admin, { infer: true }) ??
      config.get(fallback, { infer: true });
    this.own = new PrismaClient({
      adapter: createPostgresAdapter({
        POSTGRES_HOST: pick('POSTGRES_ADMIN_HOST', 'POSTGRES_HOST'),
        POSTGRES_PORT: pick('POSTGRES_ADMIN_PORT', 'POSTGRES_PORT'),
        POSTGRES_DATABASE: pick('POSTGRES_ADMIN_DATABASE', 'POSTGRES_DATABASE'),
        POSTGRES_USER: user,
        POSTGRES_PASSWORD: password,
        POSTGRES_SSL_MODE: pick('POSTGRES_ADMIN_SSL_MODE', 'POSTGRES_SSL_MODE'),
      }),
    });
    this.db = this.own;
  }

  /** True when a separate privileged pool is configured. */
  get separate(): boolean {
    return this.own !== null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.own) return;
    await this.own.$connect();
    await assertUtcSession(this.own);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.own) await this.own.$disconnect();
  }
}
