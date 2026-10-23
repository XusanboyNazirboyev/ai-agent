import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Startup smoke test: boots the real AppModule through the Nest DI container
 * (every module, provider and lifecycle hook) against the isolated test
 * database and Redis, then serves /health. Unit tests construct providers
 * directly and cannot catch unresolvable constructor parameters.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Startup smoke test requires agentcore_test');
}

// Point the application at the test database; never the development one.
for (const key of [
  'HOST',
  'PORT',
  'DATABASE',
  'USER',
  'PASSWORD',
  'SSL_MODE',
]) {
  const value = process.env[`TEST_POSTGRES_${key}`];
  if (value !== undefined) process.env[`POSTGRES_${key}`] = value;
}
process.env.NODE_ENV = 'test';

describe('application startup', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const { AppModule } = await import('./app.module.js');
    // abortOnError: false surfaces DI failures as test errors instead of
    // Nest calling process.exit inside the test worker.
    app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolves every provider and serves the health endpoint', async () => {
    const response = await fetch(`${await app.getUrl()}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
