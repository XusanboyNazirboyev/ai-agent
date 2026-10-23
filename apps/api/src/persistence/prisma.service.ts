import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client.js';
import type { AppEnvironment } from '../config/environment.js';
import { createPostgresAdapter } from './postgres-adapter.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
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
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
