/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistenceModule } from './persistence.module.js';
import { PrismaService } from './prisma.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Shutdown tests require agentcore_test');

const log: string[] = [];

/** Stands for a queue worker: it finishes an active job while shutting down. */
@Injectable()
class SlowWorker implements OnModuleDestroy {
  constructor(private readonly prisma: PrismaService) {}
  async onModuleDestroy(): Promise<void> {
    await new Promise((done) => setTimeout(done, 150));
    const rows = await this.prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    log.push(`job wrote: ${rows[0]!.ok}`);
  }
}

@Module({ imports: [PersistenceModule], providers: [SlowWorker] })
class WorkerModule {}

/** As in the app: the worker sits deeper than the database module. */
@Module({ imports: [WorkerModule] })
class FeatureModule {}

describe('graceful shutdown order (AUD-06)', () => {
  it('lets a worker finish its database work before the pool closes', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => key.startsWith('TEST_POSTGRES_'))
        .map(([key, value]) => [key.replace('TEST_', ''), value]),
    );
    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => env],
        }),
        PersistenceModule,
        FeatureModule,
      ],
    })
    class Root {}
    const app = await NestFactory.createApplicationContext(Root, {
      logger: false,
    });
    await app.close();
    expect(log).toEqual(['job wrote: 1']);
  });
});
