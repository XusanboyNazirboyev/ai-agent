import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  parsePostgresEnvironment,
  postgresPoolOptions,
} from '../config/postgres-config.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { assertUtcSession } from './postgres-adapter.js';

/**
 * DEF-007: `@prisma/adapter-pg` sends a `DateTime` as a UTC wall-clock string
 * without an offset, and PostgreSQL reads such a literal in the session
 * `TimeZone`. Under a non-UTC session (the dev server runs Asia/Tashkent) the
 * stored instant was off by the zone offset; the adapter's read path drops
 * the offset again, so Prisma round trips hid it and only SQL time
 * (`extract(epoch …)`, `now()`, column defaults) saw it.
 *
 * `control` is a session explicitly in Asia/Tashkent (the old behavior on the
 * dev server), so the shift is reproduced on any server, CI included.
 * `pinned` uses the real pool options with a non-UTC TimeZone inherited from
 * PGOPTIONS: the UTC pin must still win. What this cannot show is a pooler
 * that drops startup options; `assertUtcSession` guards that at startup.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const database = process.env.TEST_POSTGRES_DATABASE;
if (
  database === process.env.POSTGRES_DATABASE ||
  (database !== 'agentcore_test' &&
    database !== process.env.TEST_POSTGRES_ALTERNATE_DATABASE)
) {
  throw new Error(
    'Timestamp integration tests require agentcore_test, or a dedicated database named in TEST_POSTGRES_ALTERNATE_DATABASE (never the dev database)',
  );
}
const config = parsePostgresEnvironment(process.env, 'TEST_');
const TASHKENT = '-c TimeZone=Asia/Tashkent';
const control = new PrismaClient({
  adapter: new PrismaPg({ ...postgresPoolOptions(config), options: TASHKENT }),
});
const pinned = new PrismaClient({
  adapter: new PrismaPg(postgresPoolOptions(config, TASHKENT)),
});
const created: string[] = [];
const FIVE_HOURS_MS = 5 * 3_600_000;

afterAll(async () => {
  if (created.length)
    await pinned.tenant.deleteMany({ where: { id: { in: created } } });
  await Promise.all([control.$disconnect(), pinned.$disconnect()]);
});

async function createTenant(
  db: PrismaClient,
  createdAt?: Date,
): Promise<string> {
  const tenant = await db.tenant.create({
    data: {
      slug: `def007-${randomUUID()}`,
      name: 'DEF-007 timestamp check',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'test',
      packVersion: '1',
      ...(createdAt ? { createdAt } : {}),
    },
  });
  created.push(tenant.id);
  return tenant.id;
}

async function storedEpochMs(id: string): Promise<number> {
  const [row] = await pinned.$queryRaw<{ ms: number }[]>`
    SELECT (extract(epoch FROM created_at) * 1000)::float8 AS ms
    FROM tenants WHERE id = ${id}::uuid`;
  return Number(row!.ms);
}

describe('stored timestamps (DEF-007)', () => {
  it('reproduces the shift in a non-UTC session (control)', async () => {
    const instant = new Date('2026-01-02T03:04:05.678Z');
    const id = await createTenant(control, instant);
    expect(await storedEpochMs(id)).toBe(instant.getTime() - FIVE_HOURS_MS);
    await expect(assertUtcSession(control)).rejects.toThrow(/Asia\/Tashkent/);
  });

  it('runs pinned sessions in UTC even when PGOPTIONS names another zone', async () => {
    await expect(assertUtcSession(pinned)).resolves.toBeUndefined();
  });

  it('stores an explicit Date as the same instant SQL reads back', async () => {
    const instant = new Date('2026-01-02T03:04:05.678Z');
    const id = await createTenant(pinned, instant);
    expect(await storedEpochMs(id)).toBe(instant.getTime());
    const read = await pinned.tenant.findUniqueOrThrow({ where: { id } });
    expect(read.createdAt.toISOString()).toBe(instant.toISOString());
  });

  it('stores @default(now()) at the true instant, consistent with SQL now()', async () => {
    const before = Date.now();
    const id = await createTenant(pinned);
    const after = Date.now();
    const stored = await storedEpochMs(id);
    expect(stored).toBeGreaterThanOrEqual(before - 1_000);
    expect(stored).toBeLessThanOrEqual(after + 1_000);
    const [row] = await pinned.$queryRaw<{ ms: number }[]>`
      SELECT (extract(epoch FROM now()) * 1000)::float8 AS ms`;
    expect(Math.abs(Number(row!.ms) - stored)).toBeLessThan(60_000);
  });

  it('compares a Date parameter against a stored column at the true instant', async () => {
    const instant = new Date('2026-03-04T05:06:07.000Z');
    const id = await createTenant(pinned, instant);
    const [row] = await pinned.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM tenants
      WHERE id = ${id}::uuid AND created_at = ${instant}
        AND created_at = timestamptz '2026-03-04 05:06:07+00'`;
    expect(Number(row!.n)).toBe(1);
  });
});
