import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { HandoverRuntime } from '../handover/handover-runtime.js';
import { createPostgresAdapter } from './postgres-adapter.js';
import { ensureRlsAppRole } from './testing/rls-app-role.js';

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
 *
 * With TEST_RLS_STRICT=1 (plan S8, CI) the same pass runs in strict mode with
 * the main pool as a NOBYPASSRLS login role (policies apply) and the
 * privileged pool as the owner: a miss then throws, which the scan runtime
 * logs as `handover.scan_failed` with the error name.
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

const STRICT = process.env.TEST_RLS_STRICT === '1';
const owner = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});

const lines: string[] = [];
const keep = (message: unknown): void => {
  if (typeof message === 'string') lines.push(message);
  else if (message instanceof Error)
    lines.push(`${message.name}: ${message.message}`);
};
const capture: LoggerService = {
  log: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  error: keep,
  fatal: keep,
  warn: keep,
};
const misses = (): string[] =>
  lines.filter(
    (line) =>
      line.includes('db.tenant_context_missing') ||
      line.includes('TenantContextError') ||
      line.includes('handover.scan_failed'),
  );

describe(`RLS tenant context in background work (plan S6/S7${STRICT ? ', strict as app role' : ''})`, () => {
  let app: INestApplication;

  beforeAll(async () => {
    const role = STRICT ? await ensureRlsAppRole(owner) : null;
    if (STRICT && !role)
      throw new Error(
        'TEST_RLS_STRICT=1 needs a test user that may create roles (CI)',
      );
    // No platform bot, in CI and locally alike (the three keys must be set
    // together or not at all), and ConfigModule may not refill them from
    // the env file: everything it needs is already in process.env.
    for (const key of [
      'TELEGRAM_CHANNEL_ACCOUNT_ID',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
    ])
      delete process.env[key];
    Object.assign(process.env, {
      ENV_FILE: resolve(process.cwd(), 'rls-background-no-env-file'),
      NODE_ENV: 'test',
      RLS_CONTEXT_MODE: STRICT ? 'strict' : 'warn',
      // Its own pool as the test (owner) role: unwrapped, so no tenant needed.
      POSTGRES_ADMIN_USER: process.env.TEST_POSTGRES_USER,
      // Strict: the main pool as the role that RLS policies bind.
      ...(role
        ? { POSTGRES_USER: role.user, POSTGRES_PASSWORD: role.password }
        : {}),
      // Nothing may reach Telegram from this test.
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
    await owner.$disconnect();
  });

  it('boots, runs every scan once and relays the outbox without a tenant-less statement', async () => {
    await app.get(HandoverRuntime).tick(new Date());
    // The outbox relay polls every 500 ms; let it run a few times.
    await new Promise((done) => setTimeout(done, 1_500));
    expect(misses()).toEqual([]);
  }, 120_000);
});
