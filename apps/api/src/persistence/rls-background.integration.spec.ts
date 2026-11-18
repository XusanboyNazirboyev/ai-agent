import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandoverRuntime } from '../handover/handover-runtime.js';

/**
 * RLS plan S6/S7 acceptance: the real AppModule in RLS_CONTEXT_MODE=warn
 * with a separate privileged pool. Start-up checks, one full pass of every
 * scheduled scan (SLA, CRM retries, follow-ups, digest, inbox prune, action
 * retries, alerts, idle return, subscriptions, retention, price lists, task
 * reminders, lead backfill) and the outbox relay may not run a single
 * statement on the main connection without a tenant. The shared test
 * database holds rows of many tenants, so the scans find real work.
 *
 * The warn reporter always logs the first miss of the process, so "no
 * `db.tenant_context_missing` line at all" means none happened.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('RLS background test requires agentcore_test');
}
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

const warnings: string[] = [];
const capture: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
  warn: (message: unknown) => {
    if (typeof message === 'string') warnings.push(message);
  },
};
const misses = (): string[] =>
  warnings.filter((line) => line.includes('db.tenant_context_missing'));

describe('RLS tenant context in background work (plan S6/S7)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      RLS_CONTEXT_MODE: 'warn',
      // Its own pool as the same test role: unwrapped, so no tenant needed.
      POSTGRES_ADMIN_USER: process.env.TEST_POSTGRES_USER,
      // Nothing may reach Telegram from this test.
      TELEGRAM_BOT_TOKEN: '000000:placeholder-not-a-token',
      TELEGRAM_API_BASE_URL: 'http://127.0.0.1:9',
      // Every scan does its work, including the ones off by default.
      ALERTS_ENABLED: 'true',
      DIGEST_ENABLED: 'true',
      DIGEST_HOUR: '0',
    });
    if (process.env.TEST_POSTGRES_PASSWORD !== undefined)
      process.env.POSTGRES_ADMIN_PASSWORD = process.env.TEST_POSTGRES_PASSWORD;
    const { AppModule } = await import('../app.module.js');
    app = await NestFactory.create(AppModule, {
      logger: capture,
      abortOnError: false,
    });
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('boots, runs every scan once and relays the outbox without a tenant-less statement', async () => {
    await app.get(HandoverRuntime).tick(new Date());
    // The outbox relay polls every 500 ms; let it run a few times.
    await new Promise((done) => setTimeout(done, 1_500));
    expect(misses()).toEqual([]);
  }, 120_000);
});
