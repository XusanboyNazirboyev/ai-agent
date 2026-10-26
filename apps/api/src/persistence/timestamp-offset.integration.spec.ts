import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from './postgres-adapter.js';

/**
 * DEF-007: `@prisma/adapter-pg` sends a `DateTime` as a UTC wall-clock string
 * without an offset, and PostgreSQL reads such a literal in the session
 * `TimeZone`. Under a non-UTC session (the dev server runs Asia/Tashkent) the
 * stored instant was off by the zone offset; the adapter's read path drops
 * the offset again, so Prisma round trips hid it and only SQL time
 * (`extract(epoch …)`, `now()`, column defaults) saw it.
 *
 * A non-UTC server default is simulated with PGOPTIONS, which node-postgres
 * uses only when the pool sets no `options` of its own.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (
  !process.env.TEST_POSTGRES_DATABASE ||
  process.env.TEST_POSTGRES_DATABASE === process.env.POSTGRES_DATABASE
) {
  throw new Error(
    'Timestamp integration tests need TEST_POSTGRES_DATABASE (not the dev database)',
  );
}
const previousOptions = process.env.PGOPTIONS;
process.env.PGOPTIONS = '-c TimeZone=Asia/Tashkent';
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const created: string[] = [];

afterAll(async () => {
  if (created.length)
    await db.tenant.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
  if (previousOptions === undefined) delete process.env.PGOPTIONS;
  else process.env.PGOPTIONS = previousOptions;
});

async function createTenant(createdAt?: Date): Promise<string> {
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
  const [row] = await db.$queryRaw<{ ms: number }[]>`
    SELECT (extract(epoch FROM created_at) * 1000)::float8 AS ms
    FROM tenants WHERE id = ${id}::uuid`;
  return Number(row!.ms);
}

describe('stored timestamps (DEF-007)', () => {
  it('runs every session in UTC whatever the server default', async () => {
    const [row] = await db.$queryRaw<{ zone: string }[]>`
      SELECT current_setting('TimeZone') AS zone`;
    expect(row!.zone).toBe('UTC');
  });

  it('stores an explicit Date as the same instant SQL reads back', async () => {
    const instant = new Date('2026-01-02T03:04:05.678Z');
    const id = await createTenant(instant);
    expect(await storedEpochMs(id)).toBe(instant.getTime());
    const read = await db.tenant.findUniqueOrThrow({ where: { id } });
    expect(read.createdAt.toISOString()).toBe(instant.toISOString());
  });

  it('stores @default(now()) at the true instant, consistent with SQL now()', async () => {
    const before = Date.now();
    const id = await createTenant();
    const after = Date.now();
    const stored = await storedEpochMs(id);
    expect(stored).toBeGreaterThanOrEqual(before - 1_000);
    expect(stored).toBeLessThanOrEqual(after + 1_000);
    const [row] = await db.$queryRaw<{ ms: number }[]>`
      SELECT (extract(epoch FROM now()) * 1000)::float8 AS ms`;
    expect(Math.abs(Number(row!.ms) - stored)).toBeLessThan(60_000);
  });

  it('compares a Date parameter against a stored column at the true instant', async () => {
    const id = await createTenant(new Date('2026-03-04T05:06:07.000Z'));
    const [row] = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM tenants
      WHERE id = ${id}::uuid AND created_at = ${new Date('2026-03-04T05:06:07.000Z')}
        AND created_at = timestamptz '2026-03-04 05:06:07+00'`;
    expect(Number(row!.n)).toBe(1);
  });
});
